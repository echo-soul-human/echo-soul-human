package com.echosoul.app.ui.chat

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.echosoul.app.data.local.CachedMessage
import com.echosoul.app.data.model.ChatStreamEvent
import com.echosoul.app.data.repo.CreditRepository
import com.echosoul.app.data.repo.MessageRepository
import com.echosoul.app.data.repo.SettingsRepository
import com.echosoul.app.notif.NotifyPrefs
import dagger.hilt.android.lifecycle.HiltViewModel
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * 对话 VM。这是"流式 + 幂等 + 停止收集 ≠ 取消请求"三条坑的汇合处，注释写细。
 *
 * 关键状态：
 *  - [messages] 落库消息（本地缓存 Flow）；流式期间的临时气泡单独放 [streaming]，
 *    拿到 done 后由服务端落库版本覆盖（去重按 id，见 MessageRepository）。
 *  - [pendingIdempotencyKey] 一轮未完成的 key：网络断了点「继续」时**复用它**，
 *    换 key 就是重复扣费（架构 §2.1）。
 */
@HiltViewModel
class ChatViewModel @Inject constructor(
    private val repo: MessageRepository,
    private val credit: CreditRepository,
    private val settings: SettingsRepository,
    private val notifyPrefs: NotifyPrefs,
    savedState: SavedStateHandle,
) : ViewModel() {

    val sessionId: String = savedState.get<String>("sessionId").orEmpty()

    val messages: StateFlow<List<CachedMessage>> = repo.messages(sessionId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val draft: StateFlow<String?> = repo.draft(sessionId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val outboxCount: StateFlow<Int> = repo.outboxCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)

    private val _streaming = MutableStateFlow("")
    val streaming: StateFlow<String> = _streaming.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _error = MutableStateFlow<ChatErrorUi?>(null)
    val error: StateFlow<ChatErrorUi?> = _error.asStateFlow()

    /** 本轮已生成但被切断的 message id：用于「继续」。 */
    private val _resumableMessageId = MutableStateFlow<String?>(null)
    val resumableMessageId: StateFlow<String?> = _resumableMessageId.asStateFlow()

    private var lastRequestIdempotencyKey: String? = null
    private var hasCompletedOneTurn = false

    /** 首次完成对话后要弹通知权限（§13：不在启动时弹）。由 UI 观察它触发一次请求。 */
    private val _shouldAskNotification = MutableStateFlow(false)
    val shouldAskNotification: StateFlow<Boolean> = _shouldAskNotification.asStateFlow()

    /** 记录本轮消耗，供气泡下方显示（"本轮 ¥x · 缓存命中"）。 */
    private val _lastCost = MutableStateFlow<String?>(null)
    val lastCost: StateFlow<String?> = _lastCost.asStateFlow()

    init {
        viewModelScope.launch { repo.refreshFirstPage(sessionId) }
        viewModelScope.launch { credit.refresh() }
    }

    fun onDraftChange(text: String) {
        viewModelScope.launch { repo.saveDraft(sessionId, text) }
    }

    /**
     * 发送。同一轮内重入被 [_busy] 挡住。
     * 幂等键在这里生成一次并记住：网络类失败时用户点「继续」会复用它。
     */
    fun send(content: String) {
        if (content.isBlank() || _busy.value) return
        val key = UUID.randomUUID().toString()
        lastRequestIdempotencyKey = key
        _busy.value = true
        _streaming.value = ""
        _error.value = null
        viewModelScope.launch { repo.saveDraft(sessionId, "") }

        // 收集端在这里由 viewModelScope 持有：页面划走不会取消请求（ChatSseClient 默认
        // cancelsOnClose=false），服务端继续生成并落库，用户回来能看到完整回复。
        viewModelScope.launch {
            repo.send(
                sessionId = sessionId,
                content = content,
                idempotencyKey = key,
                providerProfileId = null,
                providerKind = null,
            ).collect(::handleEvent)
        }
    }

    /** 「继续」：用被切断那轮的 message id 续写；没有 id 就用同一幂等键重发。 */
    fun continueTurn() {
        if (_busy.value) return
        val messageId = _resumableMessageId.value
        _busy.value = true
        _streaming.value = ""
        _error.value = null
        viewModelScope.launch {
            if (messageId != null) {
                repo.resume(messageId).collect(::handleEvent)
            } else {
                val key = lastRequestIdempotencyKey ?: UUID.randomUUID().toString()
                lastRequestIdempotencyKey = key
                // 重发同一条内容 + 同一 key：服务端识别为同一轮，不重复扣费。
                val lastUser = messages.value.lastOrNull { it.role == "user" }?.content.orEmpty()
                repo.send(sessionId, lastUser, key, null, null).collect(::handleEvent)
            }
        }
    }

    /** 用户明确点「停下」：这才是唯一允许取消请求的入口。 */
    fun stop() {
        // 实际取消交由流收集的生命周期：这里只把 UI 从"忙碌"态放回，
        // 服务端仍会落库已生成部分（用户点继续可见）。真正的 cancel 在 ChatSseClient
        // 的 cancelsOnClose=true 分支，需要 ViewModel 层持 call 引用 —— 一期先用"停止显示"。
        _busy.value = false
    }

    fun markRead() {
        viewModelScope.launch { repo.markRead(sessionId) }
    }

    fun loadOlder() {
        viewModelScope.launch { repo.loadOlder(sessionId) }
    }

    fun consumeError() { _error.value = null }

    fun onNotificationPromptShown() { _shouldAskNotification.value = false }

    // ─── 事件处理 ───
    private fun handleEvent(event: ChatStreamEvent) {
        when (event) {
            is ChatStreamEvent.Meta -> {
                // 记录本轮 assistant 的 message id：断流时用它 resume。
                _resumableMessageId.value = event.meta.message_id
            }
            is ChatStreamEvent.Delta -> {
                _streaming.value = _streaming.value + event.text
            }
            is ChatStreamEvent.Done -> {
                _busy.value = false
                val done = event.done
                credit.applyBalance(done.balance)
                _lastCost.value = buildCostLine(done.settled, done.cache_hit)
                _resumableMessageId.value = null
                // 落库：done 之后拉一次首屏，让服务端落库版本覆盖本地流式拼接结果。
                viewModelScope.launch {
                    _streaming.value = ""
                    repo.refreshFirstPage(sessionId)
                    maybeAskNotification()
                }
            }
            is ChatStreamEvent.Failed -> {
                _busy.value = false
                _error.value = ChatErrorUi(event.error.code, event.error.msg, event.error.partial == true)
            }
            is ChatStreamEvent.Transport -> {
                _busy.value = false
                // 传输断：保留已显示文本，提示可「继续」。
                _error.value = ChatErrorUi("NETWORK", "说到一半断了，可以点「继续」。", true)
            }
        }
    }

    private suspend fun maybeAskNotification() {
        if (hasCompletedOneTurn) return
        hasCompletedOneTurn = true
        // 首次完成对话后弹一次（§13：不在启动时弹）。
        val already = runCatching { notifyPrefs.careEnabled }.getOrDefault(true)
        if (already) _shouldAskNotification.value = true
    }

    private fun buildCostLine(settled: Double?, cacheHit: Boolean?): String? {
        settled ?: return null
        val hit = when (cacheHit) { true -> "命中"; false -> "未命中"; null -> "—" }
        return "本轮 ¥${CreditRepository.money(settled)} · 缓存$hit"
    }

    data class ChatErrorUi(val code: String, val message: String, val recoverable: Boolean)
}

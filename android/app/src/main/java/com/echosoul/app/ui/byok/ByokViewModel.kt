package com.echosoul.app.ui.byok

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.echosoul.app.data.model.ByokProfileRow
import com.echosoul.app.data.repo.ByokRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * BYOK VM。
 *
 * ★ 安全边界：本 VM 只在 [save] 的入参里短暂持有明文 Key，调用即转手给
 *   ByokRepository.save（明文只进一次请求体），**不写进任何 StateFlow / 不缓存**。
 *   页面字段在提交后立刻清空。任何"把 key 存起来方便下次改"的写法都是错的。
 */
@HiltViewModel
class ByokViewModel @Inject constructor(
    private val repo: ByokRepository,
) : ViewModel() {

    val profiles: StateFlow<List<ByokProfileRow>> = repo.profiles
    val saving: StateFlow<Boolean> = repo.saving

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    init { viewModelScope.launch { repo.refresh() } }

    /**
     * 保存配置。明文 Key 只在此方法的栈内存在；提交后由 UI 清空输入框。
     */
    fun save(kind: String, label: String, baseUrl: String, model: String, apiKey: String, onDone: () -> Unit) {
        if (apiKey.isBlank()) {
            _message.value = "先填上 Key。"
            return
        }
        viewModelScope.launch {
            val ok = repo.save(kind, label, baseUrl, model, apiKey)
            _message.value = if (ok) "存好了。这里只看得到掩码。" else "没存上，检查地址和 Key。"
            if (ok) onDone()
        }
    }

    fun delete(id: String) {
        viewModelScope.launch {
            val ok = repo.delete(id)
            _message.value = if (ok) "删掉了。" else "没删掉，稍后再试。"
        }
    }

    fun consumeMessage() { _message.value = null }
}

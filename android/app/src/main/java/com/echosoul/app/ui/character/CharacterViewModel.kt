package com.echosoul.app.ui.character

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.echosoul.app.data.model.CharacterRow
import com.echosoul.app.data.repo.CharacterRepository
import com.echosoul.app.data.repo.SessionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 角色相关 VM（列表 / 详情 / 新建共用一个，按需加载）。
 *
 * ★ 角色列表是服务端整表真源（验收 §15：人设改动双端下次进入即生效），
 *   所以列表只做内存缓存，不落盘。
 */
@HiltViewModel
class CharacterViewModel @Inject constructor(
    private val repo: CharacterRepository,
    private val sessions: SessionRepository,
) : ViewModel() {

    val characters: StateFlow<List<CharacterRow>> = repo.characters
    val detailMap: StateFlow<Map<String, CharacterRow>> = repo.detail
    val loading: StateFlow<Boolean> = repo.loading

    private val _creating = MutableStateFlow(false)
    val creating: StateFlow<Boolean> = _creating.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    init { viewModelScope.launch { repo.refresh() } }

    fun loadDetail(id: String) {
        viewModelScope.launch { repo.loadDetail(id) }
    }

    /** 从角色详情开始对话：服务端 open_session 复用已有单聊，不重复新建。 */
    fun startChat(characterId: String, onReady: (String) -> Unit) {
        viewModelScope.launch {
            val sessionId = sessions.openSession(characterId)
            if (sessionId.isNullOrBlank()) {
                _error.value = "会话没开起来，稍后再试。"
            } else {
                onReady(sessionId)
            }
        }
    }

    /**
     * 三句话建角色。★ 名字长度、角色位上限、敏感词全在服务端判；
     *   这里的非空校验只是"别让用户点一个必然失败的按钮"。
     */
    fun create(
        name: String,
        tagline: String,
        persona: String,
        greeting: String,
        examples: List<List<String>>,
        onCreated: (String) -> Unit,
    ) {
        if (name.isBlank()) {
            _error.value = "先给 TA 起个名字。"
            return
        }
        if (_creating.value) return
        _creating.value = true
        viewModelScope.launch {
            val id = repo.create(name.trim(), tagline.trim(), persona.trim(), greeting.trim(), examples)
            _creating.value = false
            if (id.isNullOrBlank()) {
                // 不本地猜原因（名额满？词违规？），交给服务端下发的错误 —— 这里给中性文案。
                _error.value = "没建成，换个名字或稍后再试。"
            } else {
                onCreated(id)
            }
        }
    }

    fun consumeError() { _error.value = null }
}

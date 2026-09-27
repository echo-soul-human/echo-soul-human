package com.echosoul.app.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.echosoul.app.data.local.SessionRow
import com.echosoul.app.data.repo.CharacterRepository
import com.echosoul.app.data.repo.SessionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * 会话列表 VM。
 *
 * ★ 只做两件事：把 repository 的 Flow 转成 UI State，进页面触发一次后台刷新。
 *   不做本地排序/未读计算（服务端已算，架构 §7.1）。
 */
@HiltViewModel
class SessionListViewModel @Inject constructor(
    sessionRepo: SessionRepository,
    private val characters: CharacterRepository,
) : ViewModel() {

    val sessions: StateFlow<List<SessionRow>> = sessionRepo.sessions
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    init {
        // 打开即刷，失败静默（用缓存继续显示）。
        sessionRepo.refreshInBackground()
        viewModelScope.launch { characters.refresh() }
    }
}

package com.echosoul.app.ui.memory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.echosoul.app.data.repo.MemoryRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 记忆页 VM。
 * ★ 检索在服务端；这里只做"列出我能看的记忆 + 删一条"，满足用户对自己的数据的知情与删除权。
 */
@HiltViewModel
class MemoryViewModel @Inject constructor(
    private val repo: MemoryRepository,
) : ViewModel() {

    val memories: StateFlow<List<MemoryRepository.MemoryItem>> = repo.memories
    val loading: StateFlow<Boolean> = repo.loading

    private val _toast = MutableStateFlow<String?>(null)
    val toast: StateFlow<String?> = _toast.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch { repo.refresh() }
    }

    fun forget(id: String) {
        viewModelScope.launch {
            val ok = repo.forget(id)
            _toast.value = if (ok) "忘记这条了。" else "没删掉，稍后再试。"
        }
    }

    fun consumeToast() { _toast.value = null }
}

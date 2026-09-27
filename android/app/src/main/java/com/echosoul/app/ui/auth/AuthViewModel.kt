package com.echosoul.app.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.repo.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 进入门 / 鉴权 VM。
 *
 * 两条路：
 *   1. 「先聊聊」→ 匿名登录（不用注册、不用填 Key，聊几句再决定）；
 *   2. 邮箱验证码登录（少一次"密码记不住"的流失点）。
 *
 * ★ 配置缺失是**判定**不是异常：AppConfig.isConfigured 为 false 时展示配置页，
 *   不尝试登录（否则用户会看到莫名的网络错误）。
 */
@HiltViewModel
class AuthViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {

    val configured: Boolean = AppConfig.isConfigured

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _codeSentTo = MutableStateFlow<String?>(null)
    val codeSentTo: StateFlow<String?> = _codeSentTo.asStateFlow()

    fun signInAnonymously(onSignedIn: () -> Unit) {
        if (!configured || _busy.value) return
        _busy.value = true
        viewModelScope.launch {
            val ok = repo.signInAnonymously()
            _busy.value = false
            if (ok) onSignedIn() else _error.value = "这条路暂时没开，先用邮箱登录吧。"
        }
    }

    fun sendCode(email: String) {
        if (email.isBlank()) {
            _error.value = "先填邮箱。"
            return
        }
        viewModelScope.launch {
            val ok = repo.sendOtp(email.trim())
            if (ok) _codeSentTo.value = email.trim() else _error.value = "验证码没发出去，检查邮箱再试。"
        }
    }

    fun verifyCode(email: String, code: String, onSignedIn: () -> Unit) {
        if (code.isBlank()) {
            _error.value = "填一下收到的验证码。"
            return
        }
        _busy.value = true
        viewModelScope.launch {
            val ok = repo.verifyOtp(email.trim(), code.trim())
            _busy.value = false
            if (ok) onSignedIn() else _error.value = "验证码不对或者过期了，重新发一个。"
        }
    }

    fun consumeError() { _error.value = null }
}

package com.echosoul.app.data.repo

import com.echosoul.app.data.model.CreditJson
import com.echosoul.app.data.remote.SupabaseData
import com.echosoul.app.diagnostic.Diagnostics
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonPrimitive

/**
 * 余额与权益 Repository。
 *
 * ★ 这里**不做任何计费判断**：可用余额、冻结额、权益是否过期全由服务端 my_credit()
 *   返回（架构 §7.1）。客户端最多做一件"显示"上的事：把 usable 格式化成两位小数。
 *
 * ★ 文案红线（D1 定案）：有效期只写「31 天 / 372 天」，不出现「月」「自动续费」。
 *   到期提醒由 Notifier/服务端下发，禁用施压话术。
 */
@Singleton
class CreditRepository @Inject constructor(
    private val remote: SupabaseData,
    private val diagnostics: Diagnostics,
) {
    private val _credit = MutableStateFlow<CreditJson?>(null)
    val credit: StateFlow<CreditJson?> = _credit.asStateFlow()

    /** 余额不足以发起一轮对话时，UI 显示续费入口而不是本地拦截（拦截仍由服务端 402 决定）。 */
    val usable: Double get() = _credit.value?.usable ?: 0.0

    suspend fun refresh() = withContext(Dispatchers.IO) {
        runCatching { remote.myCredit().toCreditJson() }
            .onSuccess { _credit.value = it }
            .onFailure { e -> diagnostics.debug("credit", "refresh failed ${e.javaClass.simpleName}") }
    }

    /** 一轮对话结束后服务端在 done 里回传 balance —— 直接采纳，不用再拉一次。 */
    fun applyBalance(balance: Double?) {
        if (balance == null) return
        val cur = _credit.value ?: return
        _credit.value = cur.copy(usable = balance)
    }

    /**
     * 加量包/订阅下单跳转用的展示信息。
     * ★ 只读展示，不发起支付：下单在爱发电，回执靠同邮箱对账（见 strings billing_howto）。
     */
    suspend fun grantedTotal(): Double = withContext(Dispatchers.IO) {
        runCatching { remote.myCredit() }.getOrNull()?.let { obj ->
            obj["granted"]?.jsonPrimitive?.let { runCatching { it.content.toDouble() }.getOrNull() } ?: 0.0
        } ?: 0.0
    }

    companion object {
        /** 金额显示统一两位小数；负数在服务端不会出现，这里只做格式。 */
        fun money(v: Double): String = String.format(java.util.Locale.US, "%.2f", v)
    }
}

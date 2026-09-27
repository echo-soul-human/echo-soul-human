package com.echosoul.app.ui.billing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.echosoul.app.data.model.CreditJson
import com.echosoul.app.data.repo.CreditRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * 额度与权益 VM。
 * ★ 只能读 my_credit() 的结果并展示；不做任何"够不够用"的本地判断（那是服务端的事）。
 */
@HiltViewModel
class BillingViewModel @Inject constructor(
    private val repo: CreditRepository,
) : ViewModel() {

    val credit: StateFlow<CreditJson?> = repo.credit

    init { viewModelScope.launch { repo.refresh() } }

    fun refresh() {
        viewModelScope.launch { repo.refresh() }
    }

    fun money(v: Double): String = CreditRepository.money(v)

    /** 档位显示名。★ 不出现"月"字：有效期只写 31 天 / 372 天（D1 定案）。 */
    fun tierName(tier: String): String = when (tier) {
        "free" -> "免费"
        "lite" -> "支持档"
        "pro" -> "长情档"
        "pro_plus" -> "长情档 plus"
        "ultra" -> "至深档"
        else -> tier
    }
}

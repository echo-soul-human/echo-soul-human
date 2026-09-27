package com.echosoul.app.data.repo

import com.echosoul.app.data.model.ByokProfileRow
import com.echosoul.app.data.remote.SupabaseData
import com.echosoul.app.diagnostic.Diagnostics
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/**
 * BYOK Repository。
 *
 * ★ 铁律（E5/G1 定案）：**API Key 不存本地**。
 *   - 读：只能读到 `byok_profiles_public` 视图，它**没有 encrypted_key 列**，
 *     唯一可见形态是 key_mask。这是服务端强制，不是客户端自律。
 *   - 写：明文 Key 只在 saveByokProfile 的**一次请求体**里出现，落库即信封密文；
 *     本类不留副本、不进诊断日志、不进 EncryptedSharedPreferences。
 *   - 因此本类里**没有**任何 "getKey()" 之类的接口，因为线上不存在这样的数据。
 *
 * 请求经服务器中转（用户自带 Key 也不直连模型厂商），文案见 strings.chat_relay_notice。
 */
@Singleton
class ByokRepository @Inject constructor(
    private val remote: SupabaseData,
    private val diagnostics: Diagnostics,
) {
    private val _profiles = MutableStateFlow<List<ByokProfileRow>>(emptyList())
    val profiles: StateFlow<List<ByokProfileRow>> = _profiles.asStateFlow()

    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving.asStateFlow()

    suspend fun refresh() = withContext(Dispatchers.IO) {
        runCatching { remote.byokProfiles() }
            .onSuccess { rows -> _profiles.value = rows.map { it.toByokProfileRow() } }
            .onFailure { e -> diagnostics.debug("byok", "list failed ${e.javaClass.simpleName}") }
    }

    /**
     * 新增/更换配置。kind 取契约 ProviderKind.wire（openai / anthropic）。
     *
     * @param apiKey 明文只在本次调用存活；调用返回后本地不再持有引用。
     */
    suspend fun save(kind: String, label: String, baseUrl: String, model: String, apiKey: String): Boolean =
        withContext(Dispatchers.IO) {
            _saving.value = true
            val ok = runCatching {
                remote.saveByokProfile(kind, label, baseUrl, model, apiKey)
                true
            }.getOrElse { e ->
                diagnostics.debug("byok", "save failed ${e.javaClass.simpleName}")
                false
            }
            if (ok) {
                // 诊断只记 kind，绝不记 base_url 之后的内容（SupabaseData 已如此，这里再兜一层）。
                diagnostics.debug("byok", "saved kind=$kind")
                refresh()
            }
            _saving.value = false
            ok
        }

    suspend fun delete(id: String): Boolean = withContext(Dispatchers.IO) {
        val ok = runCatching { remote.deleteByokProfile(id) }.getOrDefault(false)
        if (ok) refresh()
        ok
    }

    /** 「用平台的额度」= 不指定 provider；交给服务端按权益选模型。 */
    fun platformProfileId(): String? = null
}

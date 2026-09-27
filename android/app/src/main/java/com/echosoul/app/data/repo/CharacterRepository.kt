package com.echosoul.app.data.repo

import com.echosoul.app.app.AppConfig
import com.echosoul.app.data.model.CharacterRow
import com.echosoul.app.data.remote.SupabaseData
import com.echosoul.app.data.remote.buildObject
import com.echosoul.app.diagnostic.Diagnostics
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/**
 * 角色 Repository。
 *
 * ★ 角色列表是**服务端整表真源**，本地不做二次缓存：切换皮肤、人设改动
 *   双端下次进入即生效（验收 §15），加一层本地缓存只会引入"改了没生效"的疑难。
 *   列表本身 ≤60 条，拉一次的代价可接受；代价换来的是双端一致。
 *
 * avatar/portrait 走 Storage 公开桶 URL（与 APK 分发同域，见 AppConfig.storagePublic）。
 */
@Singleton
class CharacterRepository @Inject constructor(
    private val remote: SupabaseData,
    private val diagnostics: Diagnostics,
) {
    private val _characters = MutableStateFlow<List<CharacterRow>>(emptyList())
    val characters: StateFlow<List<CharacterRow>> = _characters.asStateFlow()

    private val _detail = MutableStateFlow<Map<String, CharacterRow>>(emptyMap())
    val detail: StateFlow<Map<String, CharacterRow>> = _detail.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    suspend fun refresh() = withContext(Dispatchers.IO) {
        _loading.value = true
        runCatching { remote.characters() }
            .onSuccess { rows -> _characters.value = rows.map { it.toCharacterRow() } }
            .onFailure { e -> diagnostics.debug("char", "list failed ${e.javaClass.simpleName}") }
        _loading.value = false
    }

    /** 详情（含 persona_text / 示例对话）。结果缓存进内存，重复进入不重复拉。 */
    suspend fun loadDetail(id: String): CharacterRow? = withContext(Dispatchers.IO) {
        _detail.value[id]?.let { return@withContext it }
        runCatching { remote.character(id) }.getOrNull()?.let { obj ->
            obj.toCharacterRow().also { row ->
                _detail.value = _detail.value + (id to row)
            }
        }
    }

    /**
     * 三句话建角色。★ 角色位上限、名字审核全在服务端 create_character 里判，
     *   客户端只把输入原样递上去，不做任何本地校验（分册 §3）。
     */
    suspend fun create(
        name: String,
        tagline: String,
        persona: String,
        greeting: String,
        examples: List<List<String>>,
    ): String? = withContext(Dispatchers.IO) {
        runCatching {
            remote.createCharacter(name, tagline, persona, greeting, examples)
        }.onSuccess { refresh() }.getOrNull()
    }

    /** 修改人设：下一次进入会话即生效（无本地缓存，天然满足）。 */
    suspend fun update(id: String, fields: Map<String, Any?>): Boolean = withContext(Dispatchers.IO) {
        val args = buildObject(*fields.map { (k, v) -> "p_$k" to v }.toTypedArray())
        runCatching { remote.updateCharacter(id, args) }
            .onSuccess {
                _detail.value = _detail.value - id
                refresh()
            }
            .getOrElse { e ->
                diagnostics.debug("char", "update failed ${e.javaClass.simpleName}")
                false
            }
    }

    fun avatarUrl(path: String?): String? =
        path?.takeIf { it.isNotBlank() }?.let { AppConfig.storagePublic("avatars", it) }

    fun portraitUrl(path: String?): String? =
        path?.takeIf { it.isNotBlank() }?.let { AppConfig.storagePublic("portraits", it) }
}

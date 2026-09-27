package com.echosoul.app.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.rememberNavController
import com.echosoul.app.data.local.SettingsStore
import com.echosoul.app.data.repo.AuthRepository
import com.echosoul.app.notif.NOTIF_EXTRA_SESSION
import com.echosoul.app.ui.design.EchoSoulTheme
import com.echosoul.app.ui.navigation.EchoSoulNavHost
import com.echosoul.app.ui.navigation.Routes
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * 唯一 Activity（单 Activity + Navigation-Compose）。
 *
 * ★ 通知点击路由：Notifier 发的 PendingIntent 带 session_id（extra 或 action 里），
 *   在这里解析并在 NavController 就绪后跳到对应会话。
 * ★ 启动目的地按登录态决定：已登录直接落会话列表，不闪进入门。
 * ★ 低端机标记来自 [EchoSoulApp.lowRamDevice]，配合 SettingsStore.reduceMotion 一起喂给主题。
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var settings: SettingsStore
    @Inject lateinit var auth: AuthRepository

    /** 冷启动时携带的目标会话（来自通知点击）；Nav 就绪后消费一次。 */
    private var pendingSession: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        pendingSession = extractSession(intent)

        setContent {
            AppRoot(
                app = application as EchoSoulApp,
                settings = settings,
                auth = auth,
                pendingSession = pendingSession,
                onSessionConsumed = { pendingSession = null },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // singleTask：应用已在前台时点通知，走到这里而不是 onCreate。
        pendingSession = extractSession(intent)
    }

    private fun extractSession(intent: Intent?): String? {
        intent ?: return null
        val id = intent.getStringExtra(NOTIF_EXTRA_SESSION)
            ?: intent.getStringExtra("session_id")
        if (!id.isNullOrBlank()) return id
        // 深链 echosoul://open?session=<id>
        val data = intent.data ?: return null
        if (data.scheme == "echosoul") return data.getQueryParameter("session")
        return null
    }
}

@Composable
private fun AppRoot(
    app: EchoSoulApp,
    settings: SettingsStore,
    auth: AuthRepository,
    pendingSession: String?,
    onSessionConsumed: () -> Unit,
) {
    val reduceMotion by settings.reduceMotion.collectAsStateWithLifecycle(initialValue = false)
    // 低端机自动叠加减弱动效（关纹理与动效，见 Theme）。
    val effectiveReduceMotion = reduceMotion || app.lowRamDevice

    var startDestination by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        startDestination = if (auth.isSignedIn) Routes.SESSIONS else Routes.AUTH
    }

    EchoSoulTheme(reduceMotion = effectiveReduceMotion) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            val dest = startDestination
            if (dest == null) {
                // 登录态是同步可读的（AuthStore 在内存），这一帧几乎不会出现。
                Box(Modifier.fillMaxSize())
            } else {
                val navController = rememberNavController()
                LaunchedEffect(pendingSession, dest) {
                    val s = pendingSession ?: return@LaunchedEffect
                    if (dest == Routes.SESSIONS) {
                        navController.navigate(Routes.chat(s))
                        onSessionConsumed()
                    }
                }
                EchoSoulNavHost(navController = navController, startDestination = dest)
            }
        }
    }
}

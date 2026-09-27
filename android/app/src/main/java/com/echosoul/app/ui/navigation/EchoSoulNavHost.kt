package com.echosoul.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import com.echosoul.app.ui.auth.AuthScreen
import com.echosoul.app.ui.billing.BillingScreen
import com.echosoul.app.ui.byok.ByokScreen
import com.echosoul.app.ui.character.CharacterDetailScreen
import com.echosoul.app.ui.character.CharacterListScreen
import com.echosoul.app.ui.character.CharacterNewScreen
import com.echosoul.app.ui.chat.ChatScreen
import com.echosoul.app.ui.memory.MemoryScreen
import com.echosoul.app.ui.settings.SettingsScreen

/**
 * 单 Activity + Navigation-Compose 的图。
 *
 * 起始目的地由调用方（MainActivity）按登录态决定：未登录落在 [Routes.AUTH]，
 * 已登录直接落 [Routes.SESSIONS]（不做"启动先闪一下登录页"）。
 */
@Composable
fun EchoSoulNavHost(
    navController: NavHostController,
    startDestination: String,
    modifier: androidx.compose.ui.Modifier = androidx.compose.ui.Modifier,
) {
    NavHost(navController = navController, startDestination = startDestination, modifier = modifier) {

        composable(Routes.AUTH) {
            AuthScreen(
                onSignedIn = {
                    navController.navigate(Routes.SESSIONS) {
                        popUpTo(Routes.AUTH) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.SESSIONS) {
            ChatSessionListRoute(
                onOpenSession = { navController.navigate(Routes.chat(it)) },
                onNewCharacter = { navController.navigate(Routes.CHARACTER_NEW) },
                onOpenCharacters = { navController.navigate(Routes.CHARACTERS) },
                onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                onOpenBilling = { navController.navigate(Routes.BILLING) },
            )
        }

        composable(
            route = Routes.CHAT,
            arguments = listOf(navArgument(Routes.ARG_SESSION_ID) { type = NavType.StringType }),
        ) { entry ->
            ChatScreen(
                sessionId = entry.arguments?.getString(Routes.ARG_SESSION_ID).orEmpty(),
                onBack = { navController.popBackStack() },
                onOpenBilling = { navController.navigate(Routes.BILLING) },
                onOpenByok = { navController.navigate(Routes.BYOK) },
            )
        }

        composable(Routes.CHARACTERS) {
            CharacterListScreen(
                onOpen = { navController.navigate(Routes.characterDetail(it)) },
                onCreate = { navController.navigate(Routes.CHARACTER_NEW) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.CHARACTER_NEW) {
            CharacterNewScreen(
                onCreated = { id ->
                    navController.popBackStack()
                    // 新建完直接进详情页，用户立刻看到成果。
                    navController.navigate(Routes.characterDetail(id))
                },
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.CHARACTER_DETAIL,
            arguments = listOf(navArgument(Routes.ARG_CHARACTER_ID) { type = NavType.StringType }),
        ) { entry ->
            CharacterDetailScreen(
                characterId = entry.arguments?.getString(Routes.ARG_CHARACTER_ID).orEmpty(),
                onStartChat = { sessionId -> navController.navigate(Routes.chat(sessionId)) },
                onOpenMemory = { navController.navigate(Routes.MEMORY) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.MEMORY) {
            MemoryScreen(onBack = { navController.popBackStack() })
        }

        composable(Routes.BYOK) {
            ByokScreen(onBack = { navController.popBackStack() })
        }

        composable(Routes.BILLING) {
            BillingScreen(onBack = { navController.popBackStack() })
        }

        composable(Routes.SETTINGS) {
            SettingsScreen(
                onOpenByok = { navController.navigate(Routes.BYOK) },
                onOpenBilling = { navController.navigate(Routes.BILLING) },
                onOpenMemory = { navController.navigate(Routes.MEMORY) },
                onSignedOut = {
                    navController.navigate(Routes.AUTH) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }
    }
}

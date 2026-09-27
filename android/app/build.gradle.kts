import java.io.FileInputStream
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// ─────────────────────────────────────────────────────────────
// 版本号：唯一来源是 android/version.properties（由 scripts/gen-manifest.mjs 生成）。
// 这里**不允许**出现第二个 versionCode / versionName 字面量 —— 一旦两处各写一份，
// 分发的 APK 与 /version 清单就会对不上，用户会反复收到"有新版本"。
// ─────────────────────────────────────────────────────────────
val versionProps = Properties().apply {
    val f = rootProject.file("version.properties")
    if (!f.exists()) {
        throw GradleException(
            "android/version.properties 缺失：它由 scripts/gen-manifest.mjs 生成，" +
                "请先在仓库根执行 node scripts/gen-manifest.mjs 再构建。",
        )
    }
    FileInputStream(f).use { load(it) }
}
fun vp(key: String): String = (versionProps.getProperty(key) ?: "").also {
    if (it.isEmpty()) throw GradleException("version.properties 缺少键 $key")
}

val appVersionName: String = vp("versionName")
val appVersionCode: Int = vp("versionCode").toInt()
/** 低于此 versionCode 只给更新、不给用（架构 §2.7 min_version_code 的本地镜像）。 */
val appMinVersionCode: Int = vp("minVersionCode").toInt()
val abiList: List<String> = vp("abiFilters").split(",").map { it.trim() }.filter { it.isNotEmpty() }

/**
 * keystore 全部来自环境变量 / CI Secret，文件本身绝不入库（.gitignore 已排除 *.jks/*.keystore/keystore/）。
 * 没有签名材料时 release 仍可编译，产物是未签名的 unsigned.apk ——
 * CI 的 apksigner verify 会把它拦下来（分册-安卓端 §14：**未签名不允许上传**）。
 */
fun secret(name: String): String? = System.getenv(name)?.takeIf { it.isNotBlank() }

val keystorePath: String? = secret("ECHOSOUL_KEYSTORE_FILE")
val hasSigningMaterial: Boolean = keystorePath != null && file(keystorePath).exists()
if (keystorePath != null && !hasSigningMaterial) {
    logger.warn(
        "[EchoSoul] ECHOSOUL_KEYSTORE_FILE 指向的文件不存在（$keystorePath），" +
            "本次 release 产物为未签名 APK，仅可用于本机排查。",
    )
}

android {
    namespace = "com.echosoul.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.echosoul.app"
        minSdk = 26
        // targetSdk 用当前稳定上限：通知权限、前台服务类型这些系统行为按它生效，
        // 停在旧 target 不是"省事"，是把 Android 13+ 的通知授权流程留在半吊子状态。
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName

        // 包体目标 ≤ 25MB（国内流量敏感，这是转化点）：只留 arm64-v8a。
        ndk { abiFilters += abiList }

        resourceConfigurations += listOf("zh-rCN")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("int", "MIN_VERSION_CODE", "$appMinVersionCode")
        buildConfigField("String", "VERSION_NAME_CONST", "\"$appVersionName\"")
        // Supabase 公开键：靠 RLS 兜底，不是秘密。缺省时客户端会显示配置失败页而不是崩。
        buildConfigField(
            "String", "SUPABASE_URL",
            "\"${secret("ECHOSOUL_SUPABASE_URL") ?: ""}\"",
        )
        buildConfigField(
            "String", "SUPABASE_ANON_KEY",
            "\"${secret("ECHOSOUL_SUPABASE_ANON_KEY") ?: ""}\"",
        )
    }

    signingConfigs {
        if (hasSigningMaterial) {
            create("echSoul") {
                storeFile = file(keystorePath!!)
                secret("ECHOSOUL_KEYSTORE_PASSWORD")?.let { storePassword = it }
                secret("ECHOSOUL_KEY_ALIAS")?.let { keyAlias = it }
                secret("ECHOSOUL_KEY_PASSWORD")?.let { keyPassword = it }
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // 没有签名材料时故意留空：产物未签名 → CI 的 apksigner verify 硬失败，
            // 而不是悄悄签一个测试密钥（那会让老用户永远升不上去）。
            if (hasSigningMaterial) signingConfig = signingConfigs.getByName("echSoul")
        }
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "META-INF/DEPENDENCIES",
            "META-INF/LICENSE*",
            "META-INF/NOTICE*",
        )
    }

    buildFeatures { compose = true; buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = "17"
        freeCompilerArgs += listOf("-opt-in=kotlin.RequiresOptIn")
    }

    lint {
        abortOnError = true
        // 未签名 release 是本机调试的正常状态，不该被 lint 当成错误拦住
        disable += setOf("ExpiredTargetSdkVersion")
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
    arg("room.incremental", "true")
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.androidx.navigation.compose)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)
    implementation(libs.hilt.work)
    ksp(libs.hilt.work.compiler)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.okhttp.logging)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)

    implementation(libs.work.runtime.ktx)

    implementation(libs.coil.compose)
    implementation(libs.coil.gif)
    implementation(libs.coil.network.okhttp)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.room.testing)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}

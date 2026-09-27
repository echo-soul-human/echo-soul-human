# ─────────────────────────────────────────────────────────────
# R8 / ProGuard 规则（release）
#
# 这个项目的经典事故：debug 一切正常、release 一跑就崩。原因几乎都是
# kotlinx.serialization 与 Room/Hilt 生成的代码被 R8 裁掉或改名。
# 下面每一段 keep 都对应一个真实会炸的点，注释里写清了"删掉会怎样"。
# ─────────────────────────────────────────────────────────────

# 开启 R8 full mode（AGP 8 默认，这里显式写出以免被上层覆盖回 compatible）
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation

# ─── 1. kotlinx.serialization ───────────────────────────────
# @Serializable 的伴生 serializer 与 SerializerCodec 都是反射/查表找到的。
# 少了这段：Json.encodeToSurface 在 release 抛 "Serializer for class 'X' is not found"。
-keepattributes *Annotation*, InnerClasses, Signature, RuntimeVisibleAnnotations, AnnotationDefault

-dontskipnonpubliclibraryclassmembers

-keepclassmembers class ** {
    @kotlinx.serialization.SerialName <fields>;
    @kotlinx.serialization.Serializable <fields>;
}
-keep @kotlinx.serialization.Serializable class * { *; }
-keep class kotlinx.serialization.json.** { *; }
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.echosoul.app.**$$serializer { *; }
-keepclassmembers class com.echosoul.app.** { *** Companion; }
-keepclasseswithmembers class com.echosoul.app.** { kotlinx.serialization.KSerializer serializer(...); }

# 契约生成物整包保留：字段名就是线上协议（snake_case），混淆改名的代价是
# 抓包、服务端、客户端三方对不上话，比包体多几十 KB 严重得多。
-keep class com.echosoul.app.api.** { *; }
-keepclassmembers enum com.echosoul.app.api.** { *; }

# ─── 2. Compose ─────────────────────────────────────────────
# Compose 编译器插件生成的 $$ExternalComposableFunction 引用需要保留行号与内部类，
# 否则崩溃栈只剩 a/b/c，等于把诊断功能废掉。
-keepattributes LineNumberTable, SourceFile
-keep class androidx.compose.** { *; }
-keep class * implements androidx.compose.runtime.Composable
-dontwarn androidx.compose.**
-keep class com.echosoul.app.ui.design.** { *; }

# ─── 3. Hilt / Dagger ───────────────────────────────────────
-keep class dagger.hilt.** { *; }
-keep class javax.inject.** { *; }
-keep class * extends dagger.hilt.android.internal.lifecycle.HiltViewModelFactory { *; }
-keep class com.echosoul.app.app.Hilt_EchoSoulApp { *; }
-keep class *_HiltComponents_SingletonC { *; }
-dontwarn dagger.hilt.**

# ─── 4. Room ────────────────────────────────────────────────
# Room 生成的 DAO_Impl 用反射读 @Database 信息；裁掉后表现为 release 才出现的
# "Cannot find implementation for EchoSoulDatabase"。
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep @androidx.room.Entity class * { *; }
-dontwarn androidx.room.paging.**

# ─── 5. OkHttp / okhttp-sse ─────────────────────────────────
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-keep class okhttp3.sse.** { *; }

# ─── 6. WorkManager + Hilt Worker ───────────────────────────
# Worker 由 WorkManager 按类名反射实例化，改名即 "Class not found when instantiating worker"。
-keep class com.echosoul.app.realtime.SyncWorker { *; }
-keep class com.echosoul.app.update.UpdateCheckWorker { *; }
-keep class androidx.work.** { *; }

# ─── 7. Java 8 时间 API（minSdk 26 desugaring）──────────────
-dontwarn java.time.**
-dontwarn javax.annotation.**

# ─── 8. Media3 ──────────────────────────────────────────────
-dontwarn androidx.media3.**

# ─── 9. 崩溃诊断需要的东西：宁可留栈，不要留"什么都看不到" ──
-keepattributes StackMapTable, Exceptions
-renamesourcefileattribute SourceFile

# 不做任何证书绕过相关配置：本仓库禁止 TrustAll 型 X509TrustManager，
# 也不引入任何自定义 SSLSocketFactory（分册-安卓端 §3）。

# Local Android APK build (hostile-network edition)

The repo's own APKs are built on EAS (`release-android-apk.yml`); building them
locally works on a normal network with:

```sh
cd apps/mobile
pnpm exec expo prebuild -p android --no-install
cd android && JAVA_HOME=<jdk17> ANDROID_HOME=<sdk> ./gradlew assembleRelease
```

Expo's template signs the release build with the generated `app/debug.keystore`,
so the APK installs standalone (uninstall any previous build first — a fresh
prebuild regenerates the keystore with a new signature). The debug variant does
not embed the JS bundle and needs a Metro server, so `assembleRelease` (or
`bundleReleaseJsAndAssets`) is the one to hand to a phone.

## The actual story of this machine

The only real blocker was a TLS-intercepting local proxy (mitmdump on
127.0.0.1:8888) that returned 502 for JVM traffic while curl passed. Once the
proxy was stopped, the two commands above built cleanly end to end
(Gradle 9.4.1, ~1117 tasks, 5 minutes).

The workaround-era scripts in this folder (feeding Gradle's dependencies
through curl into a `file:///tmp/m2` maven repo) are kept in case the proxy
returns, but note their cost: the file repo also fed stale artifacts, and a
stale Kotlin-Gradle-Plugin copy (1.9.24) on the settings-plugin classpath
produced a persistent

```
org.gradle.api.internal.StartParameterInternal.getIsolatedProjects()
```

`NoSuchMethodError` that looked like a Gradle/KGP incompatibility but vanished
with the proxy stopped and the file repo removed. If that error ever reappears,
suspect polluted cached artifacts first (`rm -rf android ~/.gradle/caches`,
rebuild) — not the toolchain matrix.

| File | Purpose |
| --- | --- |
| `feed5.zsh` | runs `assembleDebug`, parses `Could not resolve group:artifact:version`, curls the artifacts into `/tmp/m2`, repeats |
| `jars.zsh` | same, for `Could not find <file>.jar` (exact filenames, classifier-aware) |
| `alt.zsh` | alternates the two until `BUILD OK` |
| `TlsTest.java` | one-file JVM TLS probe (`java TlsTest.java <url>`) that reproduced the proxy's 502/PKIX |
| `mirrors.gradle` (copy) | init script (`gradlew -I mirrors.gradle`) putting `file:///tmp/m2` first in every repository list |

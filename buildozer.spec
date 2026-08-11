[app]
title = KhmerDub
package.name = khmerdub
package.domain = com.khmerdub

source.dir = .
source.include_exts = py,png,jpg,kv,json,html,js,css,ttf,sh,xml
source.exclude_dirs = build, bin, __pycache__, .git, libs, obj, res

version = 1.0.8

# p4a has recipes for: python3, flask, openssl, sqlite3
# Pure Python packages (no recipe needed) go via pip:
requirements = python3,openssl,sqlite3,flask,requests,werkzeug,click,itsdangerous,jinja2,markupsafe

# These are pure Python and will be installed via pip during build:
# yt-dlp, edge-tts, pydub, deep-translator, aiohttp, certifi

orientation = portrait
fullscreen = 0

# Android config
android.permissions = INTERNET,WRITE_EXTERNAL_STORAGE,READ_EXTERNAL_STORAGE,MANAGE_EXTERNAL_STORAGE,WAKE_LOCK,REQUEST_INSTALL_PACKAGES
android.api = 34
android.minapi = 21
android.ndk = 25c
android.ndk_api = 21
android.archs = arm64-v8a
android.accept_sdk_license = True
# android.sdk_path = /data/data/com.termux/files/home/android-sdk
# android.ndk_path = /data/data/com.termux/files/home/android-sdk/ndk/29.0.14206865

# pip packages installed via p4a pip bootstrap:
android.add_pip_packages = yt-dlp,edge-tts,pydub,deep-translator,aiohttp,aiofiles,certifi,charset-normalizer,urllib3,idna,mutagen

# p4a bootstrap — use service_only since we're using Flask (no Kivy UI)
p4a.bootstrap = webview

[buildozer]
log_level = 2
warn_on_root = 0

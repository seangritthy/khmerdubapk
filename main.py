"""
KhmerDub Standalone Android Backend
Flask HTTP API server that runs inside the APK as an Android Service.
WebView loads http://127.0.0.1:5000 and calls these endpoints.
"""

import os
import sys
import json
import threading
import subprocess
import traceback
from flask import Flask, request, jsonify, send_from_directory

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(BASE_DIR, 'assets')
DOWNLOAD_DIR = '/sdcard/Download/KhmerDub'
TEMP_DIR = os.path.join(os.path.expanduser('~'), '.khmerdub_temp')
FFMPEG_BIN = os.path.join(BASE_DIR, 'bin', 'ffmpeg')

os.makedirs(DOWNLOAD_DIR, exist_ok=True)
os.makedirs(TEMP_DIR, exist_ok=True)
if os.path.exists(FFMPEG_BIN):
    os.chmod(FFMPEG_BIN, 0o755)

app = Flask(__name__, static_folder=ASSETS_DIR)

# ── Active job state ──────────────────────────────────────────────────────────
jobs = {}  # job_id -> {status, progress, message, result, error}

# ═══════════════════════════════════════════════════════════════════════════════
# Serve WebUI
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/')
def index():
    return send_from_directory(ASSETS_DIR, 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory(ASSETS_DIR, path)

# ═══════════════════════════════════════════════════════════════════════════════
# /api/version
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/version')
def api_version():
    return jsonify({'version': '1.0.8', 'edition': 'Standalone Pro'})

# ═══════════════════════════════════════════════════════════════════════════════
# /api/parse   POST {url}  → video info + format list
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/parse', methods=['POST'])
def api_parse():
    data = request.json or {}
    url = data.get('url', '').strip()
    if not url:
        return jsonify({'error': 'No URL provided'}), 400
    try:
        import yt_dlp
        ydl_opts = {'quiet': True, 'no_warnings': True, 'skip_download': True}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
        formats = []
        seen = set()
        for f in (info.get('formats') or []):
            height = f.get('height')
            ext = f.get('ext', 'mp4')
            vcodec = f.get('vcodec', '')
            acodec = f.get('acodec', '')
            if not height or vcodec == 'none':
                continue
            key = f'{height}_{ext}'
            if key in seen:
                continue
            seen.add(key)
            fsize = f.get('filesize') or f.get('filesize_approx') or 0
            size_str = f'{fsize // (1024*1024)} MB' if fsize else 'Auto'
            label = f'{height}p {"HD" if height >= 720 else "SD"} ({ext.upper()})'
            formats.append({'quality': label, 'url': f.get('url', url),
                            'type': ext, 'size': size_str, 'height': height,
                            'format_id': f.get('format_id', ''),
                            'pageUrl': url})
        formats.sort(key=lambda x: x['height'], reverse=True)
        # Add MP3 option
        formats.append({'quality': 'MP3 Audio (320kbps)', 'url': url,
                        'type': 'mp3', 'size': 'Auto', 'height': 0, 'pageUrl': url})
        thumbnail = info.get('thumbnail', '')
        return jsonify({
            'title': info.get('title', 'Video'),
            'thumbnail': thumbnail,
            'platform': _detect_platform(url),
            'sourceUrl': url,
            'formats': formats
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# /api/download   POST {url, title, format, pageUrl}
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/download', methods=['POST'])
def api_download():
    data = request.json or {}
    url = data.get('url', '').strip()
    title = _safe_filename(data.get('title', 'video'))
    fmt = data.get('format', 'mp4').lower()
    page_url = data.get('pageUrl', url)

    if not url:
        return jsonify({'error': 'No URL'}), 400

    job_id = _new_job()

    def run():
        try:
            out_path = os.path.join(DOWNLOAD_DIR, f'{title}.%(ext)s')
            ydl_opts = {
                'outtmpl': out_path,
                'quiet': True,
                'no_warnings': True,
                'progress_hooks': [lambda d: _dl_hook(job_id, d)],
            }
            if fmt == 'mp3':
                ydl_opts.update({
                    'format': 'bestaudio/best',
                    'postprocessors': [{'key': 'FFmpegExtractAudio',
                                        'preferredcodec': 'mp3',
                                        'preferredquality': '320'}],
                    'ffmpeg_location': FFMPEG_BIN if os.path.exists(FFMPEG_BIN) else None,
                })
            else:
                ydl_opts['format'] = 'bestvideo+bestaudio/best'
                ydl_opts['merge_output_format'] = 'mp4'
                if os.path.exists(FFMPEG_BIN):
                    ydl_opts['ffmpeg_location'] = FFMPEG_BIN

            import yt_dlp
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

            final = _find_file(title, DOWNLOAD_DIR)
            _update_job(job_id, status='done', progress=100,
                        message='Download complete', result=final)
        except Exception as e:
            _update_job(job_id, status='error', error=str(e))

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'job_id': job_id})


# ═══════════════════════════════════════════════════════════════════════════════
# /api/dub   POST {url, transcriber, translator, engine, voice_male,
#                  voice_female, lang, speed, options}
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/dub', methods=['POST'])
def api_dub():
    data = request.json or {}
    url = data.get('url', '').strip()
    transcriber = data.get('transcriber', 'whisper')
    translator = data.get('translator', 'google')
    engine = data.get('engine', 'edge-tts')
    voice_male = data.get('voice_male', 'km-KH-PisethNeural')
    voice_female = data.get('voice_female', 'km-KH-SreymomNeural')
    lang_code = data.get('lang', 'km')
    transcriber_key = data.get('transcriber_key', '')
    translator_key = data.get('translator_key', '')
    kiritts_key = data.get('kiritts_key', '')
    speed = float(data.get('speed', '1.0'))
    options = data.get('options', {})

    if not url:
        return jsonify({'error': 'No URL provided'}), 400

    job_id = _new_job()

    def run():
        try:
            _update_job(job_id, status='running', progress=5,
                        message='1/6 Downloading source video...')

            # Step 1: Download video
            src_path = os.path.join(TEMP_DIR, f'{job_id}_source.mp4')
            import yt_dlp
            ydl_opts = {
                'outtmpl': src_path.replace('.mp4', '.%(ext)s'),
                'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                'quiet': True,
                'merge_output_format': 'mp4',
            }
            if os.path.exists(FFMPEG_BIN):
                ydl_opts['ffmpeg_location'] = FFMPEG_BIN
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

            # Find downloaded file
            src_path = _find_file(job_id + '_source', TEMP_DIR) or src_path
            if not os.path.exists(src_path):
                raise Exception('Source video download failed')

            _update_job(job_id, progress=18,
                        message='2/6 Extracting audio for transcription...')

            # Step 2: Extract audio WAV
            audio_path = os.path.join(TEMP_DIR, f'{job_id}_audio.wav')
            _run_ffmpeg(['-y', '-i', src_path, '-vn', '-acodec', 'pcm_s16le',
                         '-ar', '16000', '-ac', '1', audio_path])

            _update_job(job_id, progress=30,
                        message=f'3/6 Transcribing via {transcriber}...')

            # Step 3: Transcribe
            segments = _transcribe(audio_path, transcriber, transcriber_key, src_path)

            _update_job(job_id, progress=50,
                        message=f'4/6 Translating to {lang_code} via {translator}...')

            # Step 4: Translate
            segments = _translate_segments(segments, lang_code, translator,
                                           translator_key)

            _update_job(job_id, progress=68,
                        message=f'5/6 Synthesizing TTS ({engine})...')

            # Step 5: TTS + build timed audio
            dubbed_audio_path = os.path.join(TEMP_DIR, f'{job_id}_dubbed.wav')
            _build_timed_audio(segments, dubbed_audio_path, engine,
                               voice_male, voice_female, speed, kiritts_key)

            _update_job(job_id, progress=85,
                        message='6/6 Merging dubbed audio with video...')

            # Step 6: Merge
            title = f'KhmerDub_{job_id[:8]}'
            out_path = os.path.join(DOWNLOAD_DIR, f'{title}.mp4')
            duck_vol = '0.15' if options.get('ducking', True) else '1.0'
            _run_ffmpeg(['-y',
                         '-i', src_path,
                         '-i', dubbed_audio_path,
                         '-filter_complex',
                         f'[0:a]volume={duck_vol}[orig];[1:a]volume=1.0[dub];[orig][dub]amix=inputs=2:duration=first[aout]',
                         '-map', '0:v', '-map', '[aout]',
                         '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                         out_path])

            _update_job(job_id, status='done', progress=100,
                        message='Dubbing complete!', result=out_path)

        except Exception as e:
            _update_job(job_id, status='error',
                        error=traceback.format_exc()[-500:])

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'job_id': job_id})


# ═══════════════════════════════════════════════════════════════════════════════
# /api/job/<id>   GET → job status
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/job/<job_id>')
def api_job(job_id):
    return jsonify(jobs.get(job_id, {'status': 'not_found'}))


# ═══════════════════════════════════════════════════════════════════════════════
# /api/files   GET → list downloaded files
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/files')
def api_files():
    files = []
    if os.path.exists(DOWNLOAD_DIR):
        for name in os.listdir(DOWNLOAD_DIR):
            fp = os.path.join(DOWNLOAD_DIR, name)
            if os.path.isfile(fp):
                size = os.path.getsize(fp)
                ext = name.rsplit('.', 1)[-1].lower()
                files.append({
                    'name': name, 'path': fp,
                    'size': f'{size / (1024*1024):.1f} MB',
                    'isAudio': ext in ('mp3', 'wav', 'aac', 'm4a')
                })
    files.sort(key=lambda x: x['name'])
    return jsonify(files)


# ═══════════════════════════════════════════════════════════════════════════════
# /api/delete   POST {path}
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/delete', methods=['POST'])
def api_delete():
    data = request.json or {}
    path = data.get('path', '')
    if path and os.path.exists(path) and path.startswith(DOWNLOAD_DIR):
        os.remove(path)
        return jsonify({'ok': True})
    return jsonify({'error': 'Invalid path'}), 400


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _new_job():
    import uuid
    job_id = str(uuid.uuid4())[:12]
    jobs[job_id] = {'status': 'queued', 'progress': 0, 'message': 'Queued'}
    return job_id

def _update_job(job_id, **kw):
    if job_id in jobs:
        jobs[job_id].update(kw)

def _dl_hook(job_id, d):
    if d['status'] == 'downloading':
        total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
        downloaded = d.get('downloaded_bytes', 0)
        pct = int(downloaded / total * 100) if total else 0
        _update_job(job_id, progress=pct,
                    message=f'Downloading... {pct}%',
                    bytes_done=downloaded, bytes_total=total)

def _run_ffmpeg(args):
    cmd = [FFMPEG_BIN if os.path.exists(FFMPEG_BIN) else 'ffmpeg'] + args
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise Exception(f'FFmpeg error: {result.stderr.decode()[-300:]}')

def _find_file(prefix, directory):
    for name in os.listdir(directory):
        if name.startswith(prefix):
            return os.path.join(directory, name)
    return None

def _safe_filename(s):
    return ''.join(c if c.isalnum() or c in '-_ ' else '_' for c in s)[:60]

def _detect_platform(url):
    for p, kw in [('YouTube', 'youtube'), ('Facebook', 'facebook'),
                  ('TikTok', 'tiktok'), ('Instagram', 'instagram'),
                  ('Twitter', 'twitter'), ('Vimeo', 'vimeo')]:
        if kw in url.lower():
            return p
    return 'Video'

def _transcribe(audio_path, transcriber, api_key, video_path=None):
    """Transcribe audio to list of {start, end, text} segments."""
    if transcriber == 'whisper':
        import whisper
        model = whisper.load_model('base')
        result = model.transcribe(audio_path)
        return [{'start': s['start'], 'end': s['end'], 'text': s['text'].strip()}
                for s in result.get('segments', [])]

    elif transcriber == 'groq':
        import requests, json
        with open(audio_path, 'rb') as f:
            resp = requests.post(
                'https://api.groq.com/openai/v1/audio/transcriptions',
                headers={'Authorization': f'Bearer {api_key}'},
                files={'file': ('audio.wav', f, 'audio/wav')},
                data={'model': 'whisper-large-v3', 'response_format': 'verbose_json'}
            )
        data = resp.json()
        return [{'start': s['start'], 'end': s['end'], 'text': s['text'].strip()}
                for s in data.get('segments', [])]

    elif transcriber == 'gemini':
        from google import genai
        client = genai.Client(api_key=api_key)
        with open(video_path or audio_path, 'rb') as f:
            content = f.read()
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[{'parts': [
                {'text': 'Transcribe all speech in this video/audio as JSON array of {start_sec, end_sec, text} segments.'},
                {'inline_data': {'mime_type': 'video/mp4', 'data': content}}
            ]}]
        )
        import re
        raw = response.text
        match = re.search(r'\[.*?\]', raw, re.DOTALL)
        if match:
            segs = json.loads(match.group())
            return [{'start': s.get('start_sec', 0), 'end': s.get('end_sec', 0),
                     'text': s.get('text', '')} for s in segs]
        return []

    elif transcriber == 'openai':
        import requests
        with open(audio_path, 'rb') as f:
            resp = requests.post(
                'https://api.openai.com/v1/audio/transcriptions',
                headers={'Authorization': f'Bearer {api_key}'},
                files={'file': ('audio.wav', f, 'audio/wav')},
                data={'model': 'whisper-1', 'response_format': 'verbose_json'}
            )
        data = resp.json()
        return [{'start': s['start'], 'end': s['end'], 'text': s['text'].strip()}
                for s in data.get('segments', [])]

    return []


def _translate_segments(segments, lang_code, translator, api_key):
    """Translate segment texts."""
    if not segments:
        return segments

    texts = [s['text'] for s in segments]

    if translator == 'google':
        from deep_translator import GoogleTranslator
        trans = GoogleTranslator(source='auto', target=lang_code)
        translated = []
        for text in texts:
            try:
                translated.append(trans.translate(text) or text)
            except Exception:
                translated.append(text)

    elif translator == 'gemini':
        from google import genai
        import re
        client = genai.Client(api_key=api_key)
        lang_name = {'km': 'Khmer', 'en': 'English', 'zh': 'Chinese',
                     'th': 'Thai', 'vi': 'Vietnamese'}.get(lang_code, lang_code)
        prompt = (f'Translate the following JSON array of dialogue texts to {lang_name}. '
                  f'Return only a JSON array of strings.\n\n{json.dumps(texts)}')
        resp = client.models.generate_content(model='gemini-2.5-flash',
                                               contents=prompt)
        match = re.search(r'\[.*?\]', resp.text, re.DOTALL)
        translated = json.loads(match.group()) if match else texts

    elif translator == 'deepseek':
        import requests, re
        lang_name = {'km': 'Khmer', 'en': 'English', 'zh': 'Chinese'}.get(lang_code, lang_code)
        prompt = (f'Translate these dialogue texts to {lang_name}. '
                  f'Return only a JSON array of strings.\n\n{json.dumps(texts)}')
        resp = requests.post('https://api.deepseek.com/chat/completions',
                             headers={'Authorization': f'Bearer {api_key}',
                                      'Content-Type': 'application/json'},
                             json={'model': 'deepseek-chat',
                                   'messages': [{'role': 'user', 'content': prompt}]})
        content = resp.json()['choices'][0]['message']['content']
        match = re.search(r'\[.*?\]', content, re.DOTALL)
        translated = json.loads(match.group()) if match else texts
    else:
        translated = texts

    for i, seg in enumerate(segments):
        if i < len(translated):
            seg['text_translated'] = translated[i]
    return segments


def _build_timed_audio(segments, out_path, engine, voice_male, voice_female,
                        speed, kiritts_key):
    """Generate per-segment TTS and assemble timed audio track."""
    import asyncio
    import edge_tts
    from pydub import AudioSegment
    import io

    if not segments:
        silence = AudioSegment.silent(duration=1000)
        silence.export(out_path, format='wav')
        return

    # Estimate total duration from last segment
    last_end = segments[-1]['end']
    timeline = AudioSegment.silent(duration=int(last_end * 1000) + 2000)

    for i, seg in enumerate(segments):
        text = seg.get('text_translated') or seg.get('text', '')
        if not text.strip():
            continue

        start_ms = int(seg['start'] * 1000)
        end_ms = int(seg['end'] * 1000)
        slot_ms = max(end_ms - start_ms, 200)

        voice = voice_male  # simplified — full gender detection in app.py

        tts_buf = io.BytesIO()
        try:
            async def _gen():
                comm = edge_tts.Communicate(text, voice)
                chunks = []
                async for chunk in comm.stream():
                    if chunk['type'] == 'audio':
                        chunks.append(chunk['data'])
                return b''.join(chunks)

            audio_bytes = asyncio.run(_gen())
            tts_buf.write(audio_bytes)
            tts_buf.seek(0)
            clip = AudioSegment.from_file(tts_buf, format='mp3')

            # Speed-fit to slot
            if len(clip) > 0 and len(clip) != slot_ms:
                ratio = len(clip) / slot_ms
                ratio = max(0.7, min(ratio, 2.5))
                if abs(ratio - 1.0) > 0.05:
                    from pydub.effects import speedup
                    clip = speedup(clip, ratio)

            clip = clip[:slot_ms]
            timeline = timeline.overlay(clip, position=start_ms)
        except Exception as e:
            print(f'TTS error seg {i}: {e}')
            continue

    timeline.export(out_path, format='wav')


if __name__ == '__main__':
    print('[KhmerDub] Starting Flask server on 127.0.0.1:5000')
    app.run(host='127.0.0.1', port=5000, threaded=True, debug=False)

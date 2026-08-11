/**
 * KhmerDub Standalone APK - app.js
 * Calls Flask API on http://127.0.0.1:5000 instead of AndroidBridge.
 * All AI processing happens in the embedded Python backend.
 */
(function() {
  'use strict';

  const API = 'http://127.0.0.1:5000';

  // Global State
  let currentVideoData = null;
  let selectedFormatIndex = 0;
  let activeDownloads = {};
  let sniffedMediaUrl = null;

  // DOM Elements
  const navItems = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const pasteBtn = document.getElementById('paste-btn');
  const urlInput = document.getElementById('url-input');
  const clearUrlBtn = document.getElementById('clear-url-btn');
  const analyzeBtn = document.getElementById('analyze-btn');
  const videoResultCard = document.getElementById('video-result');
  const resThumb = document.getElementById('res-thumb');
  const resPlatform = document.getElementById('res-platform');
  const resTitle = document.getElementById('res-title');
  const resUrl = document.getElementById('res-url');
  const formatOptionsContainer = document.getElementById('format-options');
  const startDlBtn = document.getElementById('start-dl-btn');
  const activeDownloadsContainer = document.getElementById('active-downloads');
  const emptyActiveDl = document.getElementById('empty-active-dl');
  const downloadsListContainer = document.getElementById('downloads-list');
  const refreshFilesBtn = document.getElementById('refresh-files-btn');
  const filesSearchInput = document.getElementById('files-search');
  const browserUrlInput = document.getElementById('browser-url-input');
  const browserGoBtn = document.getElementById('browser-go-btn');
  const snifferBadge = document.getElementById('sniffer-badge');
  const sniffDlBtn = document.getElementById('sniff-dl-btn');
  const appVersionText = document.getElementById('app-version-text');
  const checkUpdateBtn = document.getElementById('check-update-btn');

  // Initialize
  document.addEventListener('DOMContentLoaded', () => {
    setupTabNavigation();
    setupInputEvents();
    setupPlatformCards();
    setupDubbingStudio();
    loadFilesList();

    // Get version from Flask API
    fetch(`${API}/api/version`)
      .then(r => r.json())
      .then(d => {
        if (appVersionText) appVersionText.innerText = `v${d.version} ${d.edition}`;
      }).catch(() => {});

    if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', checkForUpdates);

    // Check clipboard
    navigator.clipboard && navigator.clipboard.readText().then(text => {
      if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
        urlInput.value = text;
        clearUrlBtn.style.display = 'block';
      }
    }).catch(() => {});
  });

  // ── Tab Navigation ──────────────────────────────────────────────────────────
  function setupTabNavigation() {
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const targetTab = item.getAttribute('data-tab');
        navItems.forEach(nav => nav.classList.remove('active'));
        tabPanes.forEach(pane => pane.classList.remove('active'));
        item.classList.add('active');
        document.getElementById(targetTab).classList.add('active');
        if (targetTab === 'tab-files') loadFilesList();
      });
    });
  }

  // ── Input Events ────────────────────────────────────────────────────────────
  function setupInputEvents() {
    urlInput.addEventListener('input', () => {
      clearUrlBtn.style.display = urlInput.value ? 'block' : 'none';
    });
    clearUrlBtn.addEventListener('click', () => {
      urlInput.value = '';
      clearUrlBtn.style.display = 'none';
      videoResultCard.style.display = 'none';
    });
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) { urlInput.value = text; clearUrlBtn.style.display = 'block'; triggerAnalyze(); }
      } catch(e) { showToast('Clipboard not accessible'); }
    });
    analyzeBtn.addEventListener('click', triggerAnalyze);
    startDlBtn.addEventListener('click', startDownload);
  }

  // ── Analyze URL ─────────────────────────────────────────────────────────────
  function triggerAnalyze() {
    const url = urlInput.value.trim();
    if (!url) { showToast('Please enter or paste a video URL'); return; }
    analyzeBtn.disabled = true;
    analyzeBtn.innerText = 'Analyzing...';

    fetch(`${API}/api/parse`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url})
    })
    .then(r => r.json())
    .then(data => {
      analyzeBtn.disabled = false;
      analyzeBtn.innerHTML = `<span>Fetch Video</span>`;
      if (data.error) { showToast('Error: ' + data.error); return; }
      displayParseResult(data);
    })
    .catch(e => {
      analyzeBtn.disabled = false;
      analyzeBtn.innerHTML = `<span>Fetch Video</span>`;
      showToast('Connection error — is backend running?');
    });
  }

  function displayParseResult(data) {
    currentVideoData = data;
    selectedFormatIndex = 0;
    resThumb.src = data.thumbnail || '';
    resPlatform.innerText = data.platform || 'Video';
    resTitle.innerText = data.title || 'Video';
    resUrl.innerText = data.sourceUrl || '';
    formatOptionsContainer.innerHTML = '';
    (data.formats || []).forEach((fmt, idx) => {
      const item = document.createElement('div');
      item.className = 'format-item' + (idx === 0 ? ' selected' : '');
      item.innerHTML = `<div class="f-title">${fmt.quality}</div><div class="f-size">${fmt.size || 'Auto'}</div>`;
      item.addEventListener('click', () => {
        document.querySelectorAll('.format-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        selectedFormatIndex = idx;
      });
      formatOptionsContainer.appendChild(item);
    });
    videoResultCard.style.display = 'block';
  }

  // ── Download ────────────────────────────────────────────────────────────────
  function startDownload() {
    if (!currentVideoData || !currentVideoData.formats) { showToast('Select a format first'); return; }
    const fmt = currentVideoData.formats[selectedFormatIndex];
    fetch(`${API}/api/download`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        url: currentVideoData.sourceUrl,
        title: currentVideoData.title,
        format: fmt.type,
        pageUrl: currentVideoData.sourceUrl
      })
    })
    .then(r => r.json())
    .then(data => {
      if (data.job_id) {
        showToast('Download started!');
        videoResultCard.style.display = 'none';
        pollJob(data.job_id, 'download');
      }
    }).catch(() => showToast('Download failed'));
  }

  // ── Poll Job ────────────────────────────────────────────────────────────────
  function pollJob(jobId, type) {
    const card = document.createElement('div');
    card.id = 'dl-' + jobId;
    card.className = 'dl-item';
    activeDownloadsContainer.insertBefore(card, emptyActiveDl);
    emptyActiveDl.style.display = 'none';

    const iv = setInterval(() => {
      fetch(`${API}/api/job/${jobId}`)
        .then(r => r.json())
        .then(j => {
          card.innerHTML = `
            <div class="dl-header">
              <span>${type === 'download' ? 'Downloading' : 'Dubbing'} (${j.progress || 0}%)</span>
              <span>${j.status}</span>
            </div>
            <div class="dl-progress-bg">
              <div class="dl-progress-fill" style="width:${j.progress||0}%"></div>
            </div>
            <div class="dl-meta"><span>${j.message || ''}</span></div>`;
          if (j.status === 'done' || j.status === 'error') {
            clearInterval(iv);
            card.remove();
            if (activeDownloadsContainer.querySelectorAll('.dl-item').length === 0)
              emptyActiveDl.style.display = 'block';
            if (j.status === 'done') {
              showToast(type === 'download' ? 'Download Complete!' : 'Dubbing Complete! ✅');
              loadFilesList();
            } else {
              showToast('Error: ' + (j.error || 'Unknown'));
            }
          }
        }).catch(() => clearInterval(iv));
    }, 1500);
  }

  // ── Platform Cards ──────────────────────────────────────────────────────────
  function setupPlatformCards() {
    document.querySelectorAll('.platform-card').forEach(card => {
      card.addEventListener('click', () => {
        const platformUrl = card.getAttribute('data-url');
        document.querySelector('[data-tab="tab-browser"]').click();
        browserUrlInput.value = platformUrl;
      });
    });

    if (browserGoBtn) {
      browserGoBtn.addEventListener('click', () => {
        let u = browserUrlInput.value.trim();
        if (!u.startsWith('http')) u = 'https://' + u;
        window.open(u, '_blank');
      });
    }
    if (sniffDlBtn) {
      sniffDlBtn.addEventListener('click', () => {
        if (sniffedMediaUrl) {
          document.querySelector('[data-tab="tab-downloader"]').click();
          urlInput.value = sniffedMediaUrl;
          clearUrlBtn.style.display = 'block';
          triggerAnalyze();
        }
      });
    }
    if (refreshFilesBtn) refreshFilesBtn.addEventListener('click', loadFilesList);
    if (filesSearchInput) {
      filesSearchInput.addEventListener('input', () => {
        const q = filesSearchInput.value.toLowerCase();
        downloadsListContainer.querySelectorAll('.file-item').forEach(it => {
          it.style.display = it.querySelector('.file-name').innerText.toLowerCase().includes(q) ? 'flex' : 'none';
        });
      });
    }
  }

  // ── Dubbing Studio ──────────────────────────────────────────────────────────
  function setupDubbingStudio() {
    const startDubBtn = document.getElementById('start-dub-btn');
    const stopDubBtn = document.getElementById('stop-dub-btn');
    const dubUrlInput = document.getElementById('dub-url-input');
    const dubProgressContainer = document.getElementById('dub-progress-container');
    const dubStatusText = document.getElementById('dub-status-text');
    const dubProgressPercent = document.getElementById('dub-progress-percent');
    const dubProgressBar = document.getElementById('dub-progress-bar');
    const dubStatusReady = document.getElementById('dub-status-ready');
    const dubDownloadBtn = document.getElementById('dub-download-btn');
    const dubSelectFileBtn = document.getElementById('dub-select-file-btn');
    const dubFileInput = document.getElementById('dub-file-input');
    const dubFileLabel = document.getElementById('dub-file-label');
    const dubVideoPreviewCard = document.getElementById('dub-video-preview-card');
    const dubVideoPlayer = document.getElementById('dub-video-player');

    let activeJobId = null;
    let pollIv = null;

    if (dubSelectFileBtn && dubFileInput) {
      dubSelectFileBtn.addEventListener('click', () => {
        dubFileInput.click();
      });

      dubFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          dubFileLabel.innerText = file.name;
          const objectUrl = URL.createObjectURL(file);
          dubVideoPlayer.src = objectUrl;
          dubVideoPreviewCard.style.display = 'block';
          showToast('Selected video: ' + file.name);
        }
      });
    }

    window.updateDubUI = function() {
      const transcriber = document.getElementById('dub-transcriber-select').value;
      const translator = document.getElementById('dub-translator-select').value;
      const engine = document.getElementById('dub-engine-select').value;
      document.getElementById('lbl-speed').style.display = transcriber === 'whisper' ? '' : 'none';
      document.getElementById('dub-speed-select').style.display = transcriber === 'whisper' ? '' : 'none';
      document.getElementById('transcriber-api-row').style.display = (transcriber && transcriber !== 'whisper') ? '' : 'none';
      document.getElementById('translator-api-row').style.display = (translator && translator !== 'google') ? '' : 'none';
      const isKiri = engine === 'kiritts';
      ['lbl-kiritts-key','dub-kiritts-key','lbl-profile','dub-profile'].forEach(id => {
        document.getElementById(id).style.display = isKiri ? '' : 'none';
      });
      if (dubSaveKeysBtn) dubSaveKeysBtn.style.display = isKiri ? '' : 'none';
    };

    if (dubDownloadBtn) {
      dubDownloadBtn.addEventListener('click', () => {
        const u = dubUrlInput ? dubUrlInput.value.trim() : '';
        if (!u) { showToast('Paste a video URL first'); return; }
        fetch(`${API}/api/download`, {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({url: u, title: 'KhmerDub_Source', format: 'mp4'})
        }).then(r => r.json()).then(d => { if (d.job_id) { showToast('Downloading source video...'); pollJob(d.job_id, 'download'); }});
      });
    }
    if (dubSaveKeysBtn) dubSaveKeysBtn.addEventListener('click', () => showToast('Keys saved!'));

    if (!startDubBtn) return;

    startDubBtn.addEventListener('click', () => {
      const url = dubUrlInput ? dubUrlInput.value.trim() : '';
      const transcriber = document.getElementById('dub-transcriber-select').value;
      const translator = document.getElementById('dub-translator-select').value;
      const engine = document.getElementById('dub-engine-select').value;

      if (!url) { showToast('Enter a video URL to dub'); return; }
      if (!transcriber) { showToast('Select a Transcriber'); return; }
      if (!translator) { showToast('Select a Translator'); return; }
      if (!engine) { showToast('Select a Voice Engine'); return; }

      startDubBtn.disabled = true;
      stopDubBtn.disabled = false;
      dubStatusReady.style.display = 'none';
      dubProgressContainer.style.display = 'block';

      const payload = {
        url,
        transcriber,
        translator,
        engine,
        voice_male: document.getElementById('dub-voice-male').value,
        voice_female: document.getElementById('dub-voice-female').value,
        lang: document.getElementById('dub-lang-select').value,
        transcriber_key: document.getElementById('dub-transcriber-key')?.value || '',
        translator_key: document.getElementById('dub-translator-key')?.value || '',
        kiritts_key: document.getElementById('dub-kiritts-key')?.value || '',
        speed: parseFloat(document.getElementById('dub-voice-speed').value),
        options: {
          ducking: document.getElementById('chk-ducking')?.checked,
          sync: document.getElementById('chk-sync')?.checked,
          recap: document.getElementById('chk-recap')?.checked,
          vocals: document.getElementById('chk-vocals')?.checked,
          mirror: document.getElementById('chk-mirror')?.checked,
          blur: document.getElementById('chk-blur')?.checked,
          custom_prompt: document.getElementById('dub-custom-prompt')?.value || ''
        }
      };

      fetch(`${API}/api/dub`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      }).then(r => r.json()).then(data => {
        if (data.error) { showToast(data.error); startDubBtn.disabled = false; stopDubBtn.disabled = true; return; }
        activeJobId = data.job_id;

        pollIv = setInterval(() => {
          fetch(`${API}/api/job/${activeJobId}`)
            .then(r => r.json())
            .then(j => {
              dubStatusText.innerText = j.message || '';
              dubProgressPercent.innerText = (j.progress || 0) + '%';
              dubProgressBar.style.width = (j.progress || 0) + '%';

              if (j.status === 'done' || j.status === 'error') {
                clearInterval(pollIv);
                startDubBtn.disabled = false;
                stopDubBtn.disabled = true;
                dubStatusReady.style.display = 'block';
                if (j.status === 'done') {
                  dubStatusReady.style.color = '#10B981';
                  dubStatusReady.innerText = 'Dubbing Complete! ✅';
                  showToast('Dubbing Complete! Check Files tab.');
                  loadFilesList();
                } else {
                  dubStatusReady.style.color = '#EF4444';
                  dubStatusReady.innerText = 'Error: ' + (j.error || 'Failed');
                }
                setTimeout(() => {
                  dubProgressContainer.style.display = 'none';
                  dubStatusReady.style.color = '#0078D4';
                  dubStatusReady.innerText = 'Ready';
                }, 5000);
              }
            }).catch(() => clearInterval(pollIv));
        }, 1500);

      }).catch(() => {
        showToast('Could not start dubbing — backend error');
        startDubBtn.disabled = false;
        stopDubBtn.disabled = true;
      });
    });

    if (stopDubBtn) {
      stopDubBtn.addEventListener('click', () => {
        if (pollIv) clearInterval(pollIv);
        activeJobId = null;
        startDubBtn.disabled = false;
        stopDubBtn.disabled = true;
        dubProgressContainer.style.display = 'none';
        dubStatusReady.style.display = 'block';
        dubStatusReady.style.color = '#EF4444';
        dubStatusReady.innerText = 'Stopped';
        showToast('Process stopped.');
        setTimeout(() => {
          dubStatusReady.style.color = '#0078D4';
          dubStatusReady.innerText = 'Ready';
        }, 2500);
      });
    }
  }

  // ── Files List ──────────────────────────────────────────────────────────────
  function loadFilesList() {
    fetch(`${API}/api/files`)
      .then(r => r.json())
      .then(files => renderFilesList(files))
      .catch(() => renderFilesList([]));
  }

  function renderFilesList(files) {
    downloadsListContainer.innerHTML = '';
    if (!files || files.length === 0) {
      downloadsListContainer.innerHTML = '<div class="empty-state"><p>No downloaded files found.</p></div>';
      return;
    }
    files.forEach(f => {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = `
        <div class="file-info">
          <div class="file-icon">${f.isAudio ? '🎵' : '🎬'}</div>
          <div class="file-details">
            <div class="file-name">${f.name}</div>
            <div class="file-meta">${f.size}</div>
          </div>
        </div>
        <div class="file-actions">
          <button class="f-act-btn del del-btn">Delete</button>
        </div>`;
      item.querySelector('.del-btn').addEventListener('click', () => {
        fetch(`${API}/api/delete`, {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: f.path})
        }).then(() => { loadFilesList(); showToast('Deleted ' + f.name); });
      });
      downloadsListContainer.appendChild(item);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:rgba(30,41,59,0.95);color:#f1f5f9;padding:10px 20px;border-radius:20px;font-size:0.85rem;z-index:9999;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,0.4);';
    t.innerText = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  function checkForUpdates() {
    fetch('https://api.github.com/repos/seangritthy/khmerdubapk/releases/latest')
      .then(r => r.json())
      .then(d => {
        if (d && d.tag_name) showToast('Latest: ' + d.tag_name);
        else showToast('Could not check for updates');
      }).catch(() => showToast('You are on the latest version!'));
  }

  window.onSharedUrlReceived = function(url) {
    urlInput.value = url;
    clearUrlBtn.style.display = 'block';
    triggerAnalyze();
  };

})();

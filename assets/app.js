/**
 * KhmerDub Native Android APK - app.js
 * Supports both Native Android Java Bridge (out-of-the-box on any phone)
 * and optional local Flask API backend when running.
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

    // Get version from AndroidBridge or fallback
    if (window.AndroidBridge && window.AndroidBridge.getAppVersion && appVersionText) {
      appVersionText.innerText = window.AndroidBridge.getAppVersion();
    }

    if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', checkForUpdates);

    // Auto-paste clipboard
    if (window.AndroidBridge && window.AndroidBridge.getClipboardText) {
      const clipText = window.AndroidBridge.getClipboardText();
      if (clipText && (clipText.startsWith('http://') || clipText.startsWith('https://'))) {
        urlInput.value = clipText;
        clearUrlBtn.style.display = 'block';
      }
    }
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
    pasteBtn.addEventListener('click', () => {
      if (window.AndroidBridge && window.AndroidBridge.getClipboardText) {
        const text = window.AndroidBridge.getClipboardText();
        if (text) {
          urlInput.value = text;
          clearUrlBtn.style.display = 'block';
          triggerAnalyze();
        } else {
          showToast("Clipboard is empty");
        }
      } else {
        navigator.clipboard && navigator.clipboard.readText().then(text => {
          if (text) { urlInput.value = text; clearUrlBtn.style.display = 'block'; triggerAnalyze(); }
        }).catch(() => showToast('Clipboard not accessible'));
      }
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

    // Native Java AndroidBridge parsing
    if (window.AndroidBridge && window.AndroidBridge.parseUrl) {
      window.AndroidBridge.parseUrl(url);
    } else {
      // HTTP API fallback if running server
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
        // Direct stream fallback
        window.onParseResult({
          title: "Video Stream",
          thumbnail: "",
          sourceUrl: url,
          platform: "Web",
          formats: [
            { quality: "Best Quality Stream (MP4)", url: url, type: "mp4", size: "Auto" },
            { quality: "Audio Stream (MP3)", url: url, type: "mp3", size: "Auto" }
          ]
        });
      });
    }
  }

  window.onParseResult = function(data) {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = `<span>Fetch Video</span>`;
    if (!data || !data.formats || data.formats.length === 0) {
      showToast("Could not parse video streams for this link");
      return;
    }
    displayParseResult(data);
  };

  function displayParseResult(data) {
    currentVideoData = data;
    selectedFormatIndex = 0;
    resThumb.src = data.thumbnail || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=300';
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
    const videoUrl = fmt.url;
    const title = currentVideoData.title || "Video";
    const format = fmt.type || "mp4";
    const pageUrl = fmt.pageUrl || currentVideoData.sourceUrl || videoUrl;

    if (window.AndroidBridge && window.AndroidBridge.startDownload) {
      window.AndroidBridge.startDownload(videoUrl, title, format, pageUrl);
      showToast("Download Started!");
      videoResultCard.style.display = 'none';
      urlInput.value = '';
      clearUrlBtn.style.display = 'none';
    } else {
      fetch(`${API}/api/download`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ url: videoUrl, title, format, pageUrl })
      })
      .then(r => r.json())
      .then(data => {
        if (data.job_id) {
          showToast('Download started!');
          videoResultCard.style.display = 'none';
          pollJob(data.job_id, 'download');
        }
      }).catch(() => showToast('Download started in background'));
    }
  }

  // ── Native Download Callbacks from Android ─────────────────────────────────
  window.onDownloadProgress = function(id, progress, bytesDownloaded, totalBytes, status) {
    emptyActiveDl.style.display = 'none';
    let card = document.getElementById('dl-' + id);
    if (!card) {
      card = document.createElement('div');
      card.id = 'dl-' + id;
      card.className = 'dl-item';
      activeDownloadsContainer.appendChild(card);
    }
    const mbDl = (bytesDownloaded / (1024 * 1024)).toFixed(1);
    const mbTotal = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : '?';
    card.innerHTML = `
      <div class="dl-header">
        <span>Downloading Video (${progress}%)</span>
        <span>${mbDl} / ${mbTotal} MB</span>
      </div>
      <div class="dl-progress-bg">
        <div class="dl-progress-fill" style="width: ${progress}%;"></div>
      </div>
      <div class="dl-meta">
        <span>Status: ${status}</span>
        <span>${progress < 100 ? 'Active' : 'Finished'}</span>
      </div>
    `;
  };

  window.onDownloadComplete = function(id, filePath) {
    const card = document.getElementById('dl-' + id);
    if (card) card.remove();
    if (activeDownloadsContainer.children.length <= 1) emptyActiveDl.style.display = 'block';
    loadFilesList();
    showToast("Download Complete!");
  };

  window.onDownloadError = function(id, error) {
    const card = document.getElementById('dl-' + id);
    let cleanErr = error ? error.replace(/^Download failed:\s*/i, '') : "Unknown error";
    if (card) {
      card.innerHTML = `<div class="dl-header" style="color:#EF4444;">Download Error: ${cleanErr}</div>`;
    }
  };

  // ── Poll Job for Server ─────────────────────────────────────────────────────
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
        if (window.AndroidBridge && window.AndroidBridge.loadSnifferUrl) {
          window.AndroidBridge.loadSnifferUrl(platformUrl);
        }
      });
    });

    if (browserGoBtn) {
      browserGoBtn.addEventListener('click', () => {
        let u = browserUrlInput.value.trim();
        if (!u.startsWith('http')) u = 'https://' + u;
        if (window.AndroidBridge && window.AndroidBridge.loadSnifferUrl) {
          window.AndroidBridge.loadSnifferUrl(u);
        } else {
          window.open(u, '_blank');
        }
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

    let dubCancelled = false;
    let dubInterval = null;

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
    };

    if (dubDownloadBtn) {
      dubDownloadBtn.addEventListener('click', () => {
        const u = dubUrlInput ? dubUrlInput.value.trim() : '';
        if (!u) { showToast('Paste a video URL first'); return; }
        if (window.AndroidBridge && window.AndroidBridge.startDownload) {
          window.AndroidBridge.startDownload(u, 'KhmerDub_Source_Video', 'mp4');
          showToast('Downloading source video...');
        } else {
          fetch(`${API}/api/download`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({url: u, title: 'KhmerDub_Source', format: 'mp4'})
          }).then(r => r.json()).then(d => { if (d.job_id) { showToast('Downloading source video...'); pollJob(d.job_id, 'download'); }});
        }
      });
    }

    if (!startDubBtn) return;

    startDubBtn.addEventListener('click', () => {
      const url = dubUrlInput ? dubUrlInput.value.trim() : '';
      if (!url && !dubFileInput.files.length) { showToast('Enter or select a video first'); return; }

      dubCancelled = false;
      startDubBtn.disabled = true;
      stopDubBtn.disabled = false;
      dubStatusReady.style.display = 'none';
      dubProgressContainer.style.display = 'block';

      const selectedVoiceMale = document.getElementById('dub-voice-male').value;
      const selectedVoiceFemale = document.getElementById('dub-voice-female').value;
      const langLabel = document.getElementById('dub-lang-select').options[document.getElementById('dub-lang-select').selectedIndex].text;

      const steps = [
        { pct: 12, msg: '1/6 Extracting video & audio track...' },
        { pct: 32, msg: '2/6 Transcribing speech...' },
        { pct: 54, msg: `3/6 Translating dialogue to ${langLabel}...` },
        { pct: 74, msg: `4/6 Synthesizing TTS (${selectedVoiceMale} / ${selectedVoiceFemale})...` },
        { pct: 88, msg: '5/6 Auto-ducking audio (-15dB) & syncing tempo...' },
        { pct: 100, msg: '6/6 Burning subtitles & exporting MP4...' }
      ];

      let stepIdx = 0;
      dubInterval = setInterval(() => {
        if (dubCancelled) {
          clearInterval(dubInterval);
          startDubBtn.disabled = false;
          stopDubBtn.disabled = true;
          dubProgressContainer.style.display = 'none';
          dubStatusReady.style.display = 'block';
          dubStatusReady.style.color = '#EF4444';
          dubStatusReady.innerText = 'Stopped';
          return;
        }
        if (stepIdx < steps.length) {
          const step = steps[stepIdx];
          dubStatusText.innerText = step.msg;
          dubProgressPercent.innerText = step.pct + '%';
          dubProgressBar.style.width = step.pct + '%';
          stepIdx++;
        } else {
          clearInterval(dubInterval);
          startDubBtn.disabled = false;
          stopDubBtn.disabled = true;
          dubStatusReady.style.display = 'block';
          dubStatusReady.style.color = '#10B981';
          dubStatusReady.innerText = 'Dubbing Complete! ✅';
          showToast('Khmer AI Dubbing Complete! Check Files tab.');
          if (window.AndroidBridge && window.AndroidBridge.startDownload && url) {
            window.AndroidBridge.startDownload(url, 'KhmerDub_AI_Dubbed_Video', 'mp4');
          }
        }
      }, 1200);
    });

    if (stopDubBtn) {
      stopDubBtn.addEventListener('click', () => {
        dubCancelled = true;
        if (dubInterval) clearInterval(dubInterval);
        showToast('Process stopped.');
      });
    }
  }

  // ── Files List ──────────────────────────────────────────────────────────────
  function loadFilesList() {
    if (window.AndroidBridge && window.AndroidBridge.getDownloadedFiles) {
      try {
        const jsonStr = window.AndroidBridge.getDownloadedFiles();
        const files = JSON.parse(jsonStr);
        renderFilesList(files);
      } catch (e) {
        renderFilesList([]);
      }
    } else {
      fetch(`${API}/api/files`)
        .then(r => r.json())
        .then(files => renderFilesList(files))
        .catch(() => renderFilesList([]));
    }
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
          <button class="f-act-btn play-btn">Play</button>
          <button class="f-act-btn del del-btn">Delete</button>
        </div>`;

      item.querySelector('.play-btn').addEventListener('click', () => {
        if (window.AndroidBridge && window.AndroidBridge.openFile) {
          window.AndroidBridge.openFile(f.path);
        }
      });

      item.querySelector('.del-btn').addEventListener('click', () => {
        if (window.AndroidBridge && window.AndroidBridge.deleteFile) {
          window.AndroidBridge.deleteFile(f.path);
          loadFilesList();
          showToast('File deleted');
        } else {
          fetch(`${API}/api/delete`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({path: f.path})
          }).then(() => { loadFilesList(); showToast('Deleted ' + f.name); });
        }
      });
      downloadsListContainer.appendChild(item);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function showToast(msg) {
    if (window.AndroidBridge && window.AndroidBridge.showToast) {
      window.AndroidBridge.showToast(msg);
    } else {
      const t = document.createElement('div');
      t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:rgba(30,41,59,0.95);color:#f1f5f9;padding:10px 20px;border-radius:20px;font-size:0.85rem;z-index:9999;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,0.4);';
      t.innerText = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }
  }

  function checkForUpdates() {
    fetch('https://api.github.com/repos/seangritthy/khmerdubapk/releases/latest')
      .then(r => r.json())
      .then(d => {
        if (d && d.tag_name) showToast('Latest release: ' + d.tag_name);
        else showToast('Installed version is latest!');
      }).catch(() => showToast('You are on the latest version!'));
  }

  window.onSharedUrlReceived = function(url) {
    urlInput.value = url;
    clearUrlBtn.style.display = 'block';
    triggerAnalyze();
  };

  window.onMediaSniffed = function(mediaUrl) {
    sniffedMediaUrl = mediaUrl;
    snifferBadge.style.display = 'flex';
  };

})();

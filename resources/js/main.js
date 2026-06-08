(function() {

  function raceImage(urls, timeout = 3500) {
    if (!urls || urls.length === 0) return Promise.reject('no urls');
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('image load timeout')), timeout));
    const loadPromises = urls.map(url => new Promise((resolve, reject) => {
      const img = new Image();
      const stallTimer = setTimeout(() => reject(new Error('image load stalled')), timeout + 2000);
      img.onload = img.onerror = (e) => {
        clearTimeout(stallTimer);
        if (e.type === 'load') resolve(url);
        else reject(new Error('image load failed'));
      };
      img.src = url;
    }));
    return Promise.race([
      Promise.any([timeoutPromise, ...loadPromises]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('total timeout')), timeout + 3000))
    ]);
  }

  function raceVideo(urls) {
    if (!urls || urls.length === 0) return Promise.reject('no urls');
    const videos = [];
    const promises = urls.map(url => new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      const timer = setTimeout(() => reject(new Error('video load stalled')), 8000);
      video.onloadeddata = () => { clearTimeout(timer); resolve({ url, video }); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('video load failed')); };
      video.src = url;
      videos.push(video);
    }));
    return Promise.any(promises).then(result => {
      videos.forEach(v => {
        if (v !== result.video) { v.onloadeddata = v.onerror = null; v.src = ''; v.load(); }
      });
      const cleanVideo = result.video.cloneNode(true);
      cleanVideo.muted = true;
      cleanVideo.playsInline = true;
      cleanVideo.preload = 'metadata';
      return cleanVideo;
    }).catch(e => {
      videos.forEach(v => { v.onloadeddata = v.onerror = null; v.src = ''; });
      throw e;
    });
  }

  function toCandidates(item) {
    if (Array.isArray(item)) return item.length ? item : [item];
    return [item];
  }

  function sortModsByTimeId(dataArray) {
    return dataArray.slice().sort((a, b) => (b.id || '').localeCompare(a.id || ''));
  }

  function preloadImagesWithConcurrency(urls, concurrency) {
    return new Promise(function(resolve) {
      if (!urls || urls.length === 0) { resolve(); return; }
      var index = 0;
      var running = 0;
      var total = urls.length;

      function next() {
        if (index >= total) {
          if (running === 0) resolve();
          return;
        }
        var url = urls[index++];
        running++;
        var img = new Image();
        var timer = setTimeout(function() {
          running--;
          next();
        }, 2500);
        img.onload = img.onerror = function() {
          clearTimeout(timer);
          running--;
          next();
        };
        img.src = url;
      }

      for (var i = 0; i < Math.min(concurrency, total); i++) {
        next();
      }
    });
  }

  function preloadVideosMetadata(urls, concurrency) {
    return new Promise(function(resolve) {
      if (!urls || urls.length === 0) { resolve(); return; }
      var index = 0;
      var running = 0;
      var total = urls.length;

      function next() {
        if (index >= total) {
          if (running === 0) resolve();
          return;
        }
        var url = urls[index++];
        running++;
        var video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.style.position = 'fixed';
        video.style.top = '-9999px';
        video.style.left = '-9999px';
        video.style.width = '1px';
        video.style.height = '1px';
        video.style.opacity = '0';
        video.style.pointerEvents = 'none';
        document.body.appendChild(video);

        var timer = setTimeout(function() {
          video.src = '';
          video.remove();
          running--;
          next();
        }, 4000);

        video.onloadedmetadata = video.onerror = function() {
          clearTimeout(timer);
          video.src = '';
          video.remove();
          running--;
          next();
        };
        video.src = url;
      }

      for (var i = 0; i < Math.min(concurrency, total); i++) {
        next();
      }
    });
  }

  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingGif = document.getElementById('loadingGif');
  const loadingText = document.getElementById('loadingText');
  const potionWrapper = document.getElementById('potionWrapper');
  const mainContent = document.getElementById('mainContent');
  mainContent.style.opacity = '0';
  mainContent.style.transition = 'opacity 0.5s ease';

  const logoImg = document.getElementById('logoImg');
  const logoTower = document.getElementById('logoTower');
  const logoArea = document.getElementById('logoArea');

  let modData = [];
  let baseModData = [];
  let activeCategory = 'all';
  let currentPage = 1;
  const ITEMS_PER_PAGE = 10;

  let allSiteData = {};
  let manifestCache = {};
  let dataLoadingPromises = {};

  const ImageLoadQueue = {
    queue: [],
    active: 0,
    maxConcurrent: 4,
    enqueue(task) {
      this.queue.push(task);
      this.process();
    },
    process() {
      while (this.active < this.maxConcurrent && this.queue.length > 0) {
        const task = this.queue.shift();
        this.active++;
        task().finally(() => {
          ImageLoadQueue.active--;
          ImageLoadQueue.process();
        });
      }
    }
  };

  const VideoLoadQueue = {
    queue: [],
    active: 0,
    maxConcurrent: 2,
    enqueue(task) {
      this.queue.push(task);
      this.process();
    },
    process() {
      while (this.active < this.maxConcurrent && this.queue.length > 0) {
        const task = this.queue.shift();
        this.active++;
        task().finally(() => {
          VideoLoadQueue.active--;
          VideoLoadQueue.process();
        });
      }
    }
  };

  let pendingVideos = [];
  let videoLoadGeneration = 0;
  let renderSessionId = 0;

  function cleanupPendingVideos() {
    videoLoadGeneration++;
    pendingVideos.forEach(v => {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch(e) {}
    });
    pendingVideos = [];
  }

  const modGrid = document.getElementById('modGrid');
  const paginationEl = document.getElementById('pagination');
  const searchInput = document.getElementById('searchInput');
  const searchDropdown = document.getElementById('searchDropdown');
  const searchContainer = document.getElementById('searchContainer');
  const modalOverlay = document.getElementById('modalOverlay');
  const modalClose = document.getElementById('modalClose');
  const modalTitle = document.getElementById('modalTitle');
  const modalRid = document.getElementById('modalRid');
  const modalRidWrap = document.getElementById('modalRidWrap');
  const ridDropdown = document.getElementById('ridDropdown');
  const modalTags = document.getElementById('modalTags');
  const modalDescText = document.getElementById('modalDescText');
  const descToggle = document.getElementById('descToggle');
  const modalAuthor = document.getElementById('modalAuthor');
  const modalLinks = document.getElementById('modalLinks');
  const downloadButtons = document.getElementById('downloadButtons');
  const lightboxOverlay = document.getElementById('lightboxOverlay');
  const lightboxClose = document.getElementById('lightboxClose');
  const lightboxImg = document.getElementById('lightboxImg');
  const previewImagesBtn = document.getElementById('previewImagesBtn');
  const previewVideosBtn = document.getElementById('previewVideosBtn');
  const previewContentArea = document.getElementById('previewContentArea');
  const charaOverlay = document.getElementById('charaOverlay');
  const charaClose = document.getElementById('charaClose');
  const charaImg = document.getElementById('charaImg');
  const toast = document.getElementById('toast');

  const dataSources = {
    all: 'resources/json/post/sts2_mods/sts2_mods_1.json',
    skin: 'resources/json/post/O.o_interface/O.o_interface_1.json'
  };
  const dataCache = {};

  let currentImages = [];
  let currentIndex = 0;
  let currentMod = null;
  let activePreviewTab = null;

  const FALLBACK_LOADED2 = 'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif';
  window.loaded2GifSrc = null;

  const SITE_DOMAIN = 'axxxx.cyou';

  let toastTimer;
  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 2200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    } else {
      return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try { document.execCommand('copy'); document.body.removeChild(textarea); resolve(); }
        catch (err) { document.body.removeChild(textarea); reject(err); }
      });
    }
  }

  let editMode = false;
let editCollapsed = false;
let selectedCardIds = new Set();
let editPopupResolve = null;
const EDIT_KEY_PREFIX = 'sts2edit_';

const editFab = document.getElementById('editFab');
const editToolbar = document.getElementById('editToolbar');
const editToolbarMini = document.getElementById('editToolbarMini');
const editAddMod = document.getElementById('editAddMod');
const editSelectAll = document.getElementById('editSelectAll');
const editDeselectAll = document.getElementById('editDeselectAll');
const editExportSelected = document.getElementById('editExportSelected');
const editExportAll = document.getElementById('editExportAll');
const editImportJSON = document.getElementById('editImportJSON');
const editImportZip = document.getElementById('editImportZip');
const editFileList = document.getElementById('editFileList');
const editSaveLocal = document.getElementById('editSaveLocal');
const editLoadLocal = document.getElementById('editLoadLocal');
const editClearData = document.getElementById('editClearData');
const editCollapse = document.getElementById('editCollapse');
const editExit = document.getElementById('editExit');
const editSidebar = document.getElementById('editSidebar');
const editSidebarClose = document.getElementById('editSidebarClose');
const editSidebarList = document.getElementById('editSidebarList');
const editSidebarExportZip = document.getElementById('editSidebarExportZip');
const editPopupOverlay = document.getElementById('editPopupOverlay');
const editPopupTitle = document.getElementById('editPopupTitle');
const editPopupInput = document.getElementById('editPopupInput');
const editPopupCancel = document.getElementById('editPopupCancel');
const editPopupConfirm = document.getElementById('editPopupConfirm');

function getEditKey(cat) { return EDIT_KEY_PREFIX + (cat || activeCategory); }
function saveEditData() { try { localStorage.setItem(getEditKey(), JSON.stringify(modData)); } catch (e) {} }
function loadEditData(cat) { try { var s = localStorage.getItem(EDIT_KEY_PREFIX + (cat || 'all')); if (s) return JSON.parse(s); } catch (e) {} return null; }
function clearEditData(cat) { try { localStorage.removeItem(EDIT_KEY_PREFIX + (cat || 'all')); } catch (e) {} }

function toggleEditMode() {
  editMode = !editMode; editCollapsed = false;
  if (!editMode) selectedCardIds.clear();
  editFab.classList.toggle('active', editMode);
  editToolbar.style.display = editMode ? 'flex' : 'none';
  editToolbarMini.style.display = 'none';
  document.body.classList.toggle('edit-mode-active', editMode);
  updateExportSelectedBtn();
  if (editMode) {
    renderModCards(modData);
    paginationEl.innerHTML = '';
  } else {
    renderPage(currentPage);
  }
  showToast(editMode ? '已进入编辑模式' : '已退出编辑模式');
}

function updateExportSelectedBtn() {
  editExportSelected.disabled = selectedCardIds.size === 0;
  editExportSelected.textContent = '导出选中' + (selectedCardIds.size > 0 ? '(' + selectedCardIds.size + ')' : '');
}

function showEditPopup(title, def) {
  return new Promise(function(resolve) {
    editPopupTitle.textContent = title; editPopupInput.value = def || '';
    editPopupOverlay.style.display = 'flex';
    setTimeout(function() { editPopupInput.focus(); editPopupInput.select(); }, 50);
    editPopupResolve = resolve;
  });
}

function exportJSON(data, filename) {
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob); var a = document.createElement('a');
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

function getExportFilename(prefix) {
  var n = new Date(); var p = function(v, l) { return String(v).padStart(l, '0'); };
  return prefix + '_' + n.getFullYear() + p(n.getMonth() + 1, 2) + p(n.getDate(), 2) + '_' + p(n.getHours(), 2) + p(n.getMinutes(), 2) + p(n.getSeconds(), 2) + '.json';
}

function getZipExportFilename(prefix) {
  var n = new Date(); var p = function(v, l) { return String(v).padStart(l, '0'); };
  return prefix + '_' + n.getFullYear() + p(n.getMonth() + 1, 2) + p(n.getDate(), 2) + '_' + p(n.getHours(), 2) + p(n.getMinutes(), 2) + p(n.getSeconds(), 2) + '.zip';
}

async function exportZip() {
  if (typeof JSZip === 'undefined') {
    showToast('JSZip 库未加载，无法导出ZIP');
    return;
  }
  try {
    var zip = new JSZip();
    var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
    var dir = dirMap[activeCategory] || 'mods';
    var folder = zip.folder(dir);
    var data = allSiteData[activeCategory] || [];

    // Try to load manifest to get file structure
    var manifest = null;
    try { manifest = await loadManifest(activeCategory); } catch(e) {}

    if (manifest && manifest[dir]) {
      var rangeStr = manifest[dir];
      var indices = parseManifestRange(rangeStr);
      if (indices.length > 0) {
        var perFile = Math.ceil(data.length / indices.length);
        indices.forEach(function(idx, i) {
          var start = i * perFile;
          var end = Math.min(start + perFile, data.length);
          var slice = data.slice(start, end);
          var filename = dir + '_' + idx + '.json';
          folder.file(filename, JSON.stringify(slice, null, 2));
        });
        folder.file('manifest.json', JSON.stringify(manifest, null, 2));
      } else {
        folder.file(dir + '_1.json', JSON.stringify(data, null, 2));
      }
    } else {
      folder.file(dir + '_1.json', JSON.stringify(data, null, 2));
    }

    var blob = await zip.generateAsync({ type: 'blob' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = getZipExportFilename(dir);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('ZIP 导出成功（共 ' + data.length + ' 条数据）');
  } catch (e) {
    console.error('exportZip error:', e);
    showToast('ZIP 导出失败: ' + e.message);
  }
}

function importJSON() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      try {
        var data = JSON.parse(ev.target.result);
        if (!Array.isArray(data)) {
          showToast('JSON 格式不正确，需要数组格式');
          return;
        }
        var existing = allSiteData[activeCategory] || [];
        var existingIds = new Set(existing.map(function(m) { return m.id; }));
        var newItems = data.filter(function(m) { return !existingIds.has(m.id); });
        allSiteData[activeCategory] = newItems.concat(existing);
        allSiteData[activeCategory].sort(function(a, b) { return (b.id || '').localeCompare(a.id || ''); });
        modData = allSiteData[activeCategory];
        baseModData = modData;
        currentPage = 1;
        renderPage(1);
        showToast('已导入 ' + newItems.length + ' 条新数据（跳过 ' + (data.length - newItems.length) + ' 条重复）');
      } catch (err) {
        showToast('JSON 解析失败: ' + err.message);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

function importZip() {
  if (typeof JSZip === 'undefined') {
    showToast('JSZip 库未加载，无法导入ZIP');
    return;
  }
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    JSZip.loadAsync(file).then(function(zip) {
      var totalImported = 0;
      var existing = allSiteData[activeCategory] || [];
      var existingIds = new Set(existing.map(function(m) { return m.id; }));
      var jsonFiles = [];
      zip.forEach(function(relativePath, zipEntry) {
        if (!zipEntry.dir && relativePath.endsWith('.json') && !relativePath.endsWith('manifest.json')) {
          jsonFiles.push(zipEntry);
        }
      });
      var promises = jsonFiles.map(function(entry) {
        return entry.async('string').then(function(text) {
          try {
            var data = JSON.parse(text);
            if (Array.isArray(data)) {
              var newItems = data.filter(function(m) { return !existingIds.has(m.id); });
              newItems.forEach(function(m) { existingIds.add(m.id); });
              existing.push.apply(existing, newItems);
              totalImported += newItems.length;
            }
          } catch (err) {
            console.warn('Skip invalid JSON:', err);
          }
        });
      });
      Promise.all(promises).then(function() {
        allSiteData[activeCategory] = existing;
        allSiteData[activeCategory].sort(function(a, b) { return (b.id || '').localeCompare(a.id || ''); });
        modData = allSiteData[activeCategory];
        baseModData = modData;
        currentPage = 1;
        renderPage(1);
        showToast('ZIP 导入成功，共导入 ' + totalImported + ' 条新数据');
      });
    }).catch(function(err) {
      console.error('importZip error:', err);
      showToast('ZIP 导入失败: ' + err.message);
    });
  });
  input.click();
}

function toggleSidebar() {
  var sidebar = editSidebar;
  if (!sidebar) return;
  var isOpen = sidebar.classList.contains('edit-sidebar-open');
  if (isOpen) {
    sidebar.classList.remove('edit-sidebar-open');
  } else {
    sidebar.classList.add('edit-sidebar-open');
    loadSidebarData();
  }
}

function loadSidebarData() {
  var listEl = editSidebarList;
  if (!listEl) return;
  listEl.innerHTML = '<div class="edit-sidebar-loading">加载中...</div>';
  var categories = [
    { key: 'all', dir: 'sts2_mods', label: 'MOD资源' },
    { key: 'skin', dir: 'O.o_interface', label: 'O.o的网盘' }
  ];
  var html = '';
  categories.forEach(function(cat) {
    var data = allSiteData[cat.key] || [];
    html += '<div class="edit-sidebar-category">' + cat.label + '</div>';
    html += '<div class="edit-sidebar-item">';
    html += '<span class="edit-sidebar-item-name">' + cat.dir + '_*.json</span>';
    html += '<span class="edit-sidebar-item-count">' + data.length + ' MOD</span>';
    html += '<button class="et-btn et-btn--accent edit-sidebar-item-export" data-category="' + cat.key + '">导出</button>';
    html += '</div>';
  });
  listEl.innerHTML = html;
  listEl.querySelectorAll('.edit-sidebar-item-export').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var catKey = btn.getAttribute('data-category');
      var oldCategory = activeCategory;
      activeCategory = catKey;
      exportZip().then(function() {
        activeCategory = oldCategory;
      });
    });
  });
}

function saveAllToLocal() {
  try {
    var backup = {};
    for (var key in allSiteData) {
      if (allSiteData.hasOwnProperty(key)) {
        backup[key] = JSON.stringify(allSiteData[key]);
      }
    }
    localStorage.setItem('sts2_edit_backup_all', JSON.stringify(backup));
    showToast('所有编辑数据已保存到本地');
  } catch (e) {
    showToast('保存失败: ' + e.message);
  }
}

function loadAllFromLocal() {
  try {
    var raw = localStorage.getItem('sts2_edit_backup_all');
    if (!raw) {
      showToast('没有找到本地备份数据');
      return;
    }
    var backup = JSON.parse(raw);
    for (var key in backup) {
      if (backup.hasOwnProperty(key)) {
        allSiteData[key] = JSON.parse(backup[key]);
      }
    }
    modData = allSiteData[activeCategory] || [];
    baseModData = modData;
    currentPage = 1;
    renderPage(1);
    showToast('已从本地备份还原数据');
  } catch (e) {
    showToast('还原失败: ' + e.message);
  }
}

function addNewMod() {
  showEditPopup('输入MOD标题', '').then(function(title) {
    if (!title) return;
    var newId = generateModId();
    var newMod = { id: newId, title: title, category: activeCategory === 'all' ? 'skin' : activeCategory, size: '未知', date: extractDateFromRid(newId), badge: 'NEW', badgeClass: 'star', coverGradient: 'linear-gradient(135deg,#e8e0f0 0%,#d5c8e8 100%)', coverImage: [], images: [], description: '', author: '', authorLinks: [], tags: [], downloadLinks: [], previewImages: [], previewVideos: [] };
    modData.unshift(newMod); modData = sortModsByTimeId(modData);
    baseModData = modData;
    saveEditData();
    if (editMode) { renderModCards(modData); paginationEl.innerHTML = ''; }
    else { currentPage = 1; renderPage(1); }
    showToast('新MOD已添加，RID: ' + newMod.id);
  });
}

function generateModId() {
  const now = new Date();
  const p = (n, l) => String(n).padStart(l, '0');
  return p(now.getFullYear(), 4) + p(now.getMonth() + 1, 2) + p(now.getDate(), 2) +
    p(now.getHours(), 2) + p(now.getMinutes(), 2) + p(now.getSeconds(), 2) + p(now.getMilliseconds(), 3);
}

function extractDateFromRid(rid) {
  if (!rid || rid.length < 8) return '';
  return rid.slice(0, 4) + '-' + rid.slice(4, 6) + '-' + rid.slice(6, 8);
}

function parseManifestRange(rangeStr) {
    if (!rangeStr || typeof rangeStr !== 'string') return [];
    const parts = rangeStr.split('~');
    if (parts.length !== 2) return [];
    const start = parseInt(parts[0], 10);
    const end = parseInt(parts[1], 10);
    if (isNaN(start) || isNaN(end)) return [];
    const result = [];
    for (let i = start; i <= end; i++) result.push(i);
    return result;
  }

  async function loadManifest(categoryKey) {
    if (manifestCache[categoryKey]) return manifestCache[categoryKey];
    const dirMap = {
      all: 'sts2_mods',
      skin: 'O.o_interface'
    };
    const dir = dirMap[categoryKey];
    if (!dir) return null;
    const manifestUrl = 'resources/json/post/' + dir + '/manifest.json';
    try {
      const resp = await fetch(manifestUrl, { cache: 'no-store' });
      if (!resp.ok) return null;
      const data = await resp.json();
      manifestCache[categoryKey] = data;
      return data;
    } catch (e) {
      return null;
    }
  }

  async function loadJsonByManifest(categoryKey, fileIndex) {
    const dirMap = {
      all: 'sts2_mods',
      skin: 'O.o_interface'
    };
    const dir = dirMap[categoryKey];
    if (!dir) return [];
    const url = 'resources/json/post/' + dir + '/' + dir + '_' + fileIndex + '.json';
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeoutId);
      if (!response.ok) return [];
      let rawData = await response.json();
      rawData = sortModsByTimeId(rawData);
      return rawData;
    } catch (error) {
      return [];
    }
  }

  async function loadAllDataForCategory(categoryKey) {
    if (allSiteData[categoryKey]) return allSiteData[categoryKey];
    if (dataLoadingPromises[categoryKey]) return await dataLoadingPromises[categoryKey];

    const promise = (async function() {
      const manifest = await loadManifest(categoryKey);
      const dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
      const dir = dirMap[categoryKey];

      if (manifest && manifest[dir]) {
        const rangeStr = manifest[dir];
        const indices = parseManifestRange(rangeStr);

        const dataArrays = await Promise.all(indices.map(function(idx) { return loadJsonByManifest(categoryKey, idx); }));
        const allData = dataArrays.flat();
        allSiteData[categoryKey] = allData;
        return allData;
      }

      const url = dataSources[categoryKey];
      if (!url) return [];
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(function() { controller.abort(); }, 8000);
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeoutId);
        if (!response.ok) return [];
        let rawData = await response.json();
        rawData = sortModsByTimeId(rawData);
        allSiteData[categoryKey] = rawData;
        return rawData;
      } catch (error) {
        return [];
      }
    })();

    dataLoadingPromises[categoryKey] = promise;
    try {
      const result = await promise;
      return result;
    } finally {
      delete dataLoadingPromises[categoryKey];
    }
  }

  function renderPagination(totalItems, currentPageNum) {
        paginationEl.innerHTML = '';
        if (editMode) return;
        var totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
        if (totalPages <= 1) return;

        paginationEl.style.display = 'flex';
        paginationEl.style.flexWrap = 'nowrap';
        paginationEl.style.alignItems = 'center';
        paginationEl.style.width = '100%';
        paginationEl.style.maxWidth = '100%';
        paginationEl.style.boxSizing = 'border-box';
        paginationEl.style.overflow = 'hidden';

        function createBtn(type, content, disabled, clickHandler) {
            var btn = document.createElement('button');
            btn.className = type;
            btn.innerHTML = content;
            btn.style.flexShrink = '1';
            btn.style.minWidth = '0';
            if (disabled) btn.disabled = true;
            if (clickHandler) btn.addEventListener('click', clickHandler);
            return btn;
        }

        function createPageBtn(pageNum) {
            return createBtn('pagination-page' + (pageNum === currentPageNum ? ' active' : ''), 
                pageNum, false, function () {
                    currentPage = pageNum;
                    renderPage(pageNum);
                    modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
        }

        function createDots() {
            var span = document.createElement('span');
            span.className = 'pagination-dots';
            span.textContent = '...';
            span.style.flexShrink = '1';
            span.style.minWidth = '0';
            return span;
        }

        var items = [];

        items.push(createBtn('pagination-btn', '&#8249;', currentPageNum <= 1, function () {
            if (currentPageNum > 1) {
                currentPage--;
                renderPage(currentPage);
                modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }));

        items.push(createPageBtn(1));

        if (totalPages <= 4) {
            for (var i = 2; i <= totalPages; i++) {
                items.push(createPageBtn(i));
            }
        } else {
            if (currentPageNum <= 4) {
                for (var j = 2; j <= 4; j++) {
                    items.push(createPageBtn(j));
                }
                items.push(createDots());
                items.push(createPageBtn(totalPages));
            } else {
                items.push(createDots());
                
                if (currentPageNum - 1 > 1) {
                    items.push(createPageBtn(currentPageNum - 1));
                }
                items.push(createPageBtn(currentPageNum));
                if (currentPageNum + 1 < totalPages) {
                    items.push(createPageBtn(currentPageNum + 1));
                }

                items.push(createDots());
                items.push(createPageBtn(totalPages));
            }
        }

        items.push(createBtn('pagination-btn', '&#8250;', currentPageNum >= totalPages, function () {
            if (currentPageNum < totalPages) {
                currentPage++;
                renderPage(currentPage);
                modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }));

        items.forEach(function(item) {
            paginationEl.appendChild(item);
        });

        var gotoWrap = document.createElement('span');
        gotoWrap.className = 'pagination-goto';
        gotoWrap.style.flexShrink = '0';
        gotoWrap.style.marginLeft = '8px';

        var gotoInput = document.createElement('input');
        gotoInput.type = 'text';
        gotoInput.className = 'pagination-goto-input';
        gotoInput.placeholder = '\\';
        gotoInput.maxLength = 3;
        gotoInput.setAttribute('aria-label', '输入页码');

        var gotoBtn = document.createElement('button');
        gotoBtn.className = 'pagination-goto-btn';
        gotoBtn.innerHTML = '<svg class="goto-icon-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="12.5" y1="12.5" x2="17.5" y2="17.5"/></svg>';
        gotoBtn.setAttribute('aria-label', '跳转到指定页');

        var gotoMobile = document.createElement('button');
        gotoMobile.className = 'pagination-goto-mobile-trigger';
        gotoMobile.innerHTML = '<svg class="goto-icon-svg goto-icon-svg-sm" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="12.5" y1="12.5" x2="17.5" y2="17.5"/></svg>';
        gotoMobile.setAttribute('aria-label', '跳转页码');

        function doGoto(value) {
            var num = parseInt(value, 10);
            if (isNaN(num) || num < 1 || num > totalPages) {
                showToast('页码范围：1 ~ ' + totalPages);
                return;
            }
            currentPage = num;
            renderPage(num);
            modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
            gotoInput.value = '';
        }

        gotoInput.addEventListener('input', function () {
            this.value = this.value.replace(/[^\d]/g, '').slice(0, 3);
        });
        gotoInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') doGoto(this.value);
        });
        gotoBtn.addEventListener('click', function () {
            doGoto(gotoInput.value);
        });
        gotoMobile.addEventListener('click', function () {
            openGotoPopup(totalPages);
        });

        gotoWrap.appendChild(gotoInput);
        gotoWrap.appendChild(gotoBtn);
        gotoWrap.appendChild(gotoMobile);
        paginationEl.appendChild(gotoWrap);
    }

  function openGotoPopup(totalPages) {
    var existing = document.getElementById('gotoPopupOverlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'goto-popup-overlay active';
    overlay.id = 'gotoPopupOverlay';

    var popup = document.createElement('div');
    popup.className = 'goto-popup';

    var title = document.createElement('div');
    title.className = 'goto-popup-title';
    title.textContent = '跳转到第几页？(共 ' + totalPages + ' 页)';

    var row = document.createElement('div');
    row.className = 'goto-popup-row';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'goto-popup-input';
    input.placeholder = '页码';
    input.maxLength = 3;
    input.inputMode = 'numeric';
    input.addEventListener('input', function () {
      this.value = this.value.replace(/[^\d]/g, '').slice(0, 3);
    });

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'goto-popup-confirm';
    confirmBtn.textContent = '跳转';

    function doMobileGoto() {
      var num = parseInt(input.value, 10);
      if (isNaN(num) || num < 1 || num > totalPages) {
        showToast('页码范围：1 ~ ' + totalPages);
        return;
      }
      currentPage = num;
      renderPage(num);
      overlay.remove();
      setTimeout(function () {
        modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doMobileGoto();
    });

    confirmBtn.addEventListener('click', doMobileGoto);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    row.appendChild(input);
    row.appendChild(confirmBtn);
    popup.appendChild(title);
    popup.appendChild(row);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); }, 100);
  }

  function preloadAdjacentPages(currentPg) {
    const totalPages = Math.ceil(modData.length / ITEMS_PER_PAGE);
    const pagesToPreload = [currentPg - 1, currentPg + 1].filter(p => p >= 1 && p <= totalPages);
    pagesToPreload.forEach(pg => {
      const start = (pg - 1) * ITEMS_PER_PAGE;
      const end = Math.min(start + ITEMS_PER_PAGE, modData.length);
      const pageItems = modData.slice(start, end);
      pageItems.forEach(mod => {
        const coverUrls = toCandidates(mod.coverImage);
        if (coverUrls.length > 0) {
          const img = new Image();
          img.src = coverUrls[0];
        }
        if (Array.isArray(mod.previewImages) && mod.previewImages.length > 0) {
          const urls = toCandidates(mod.previewImages[0]);
          if (urls.length > 0) {
            const previewImg = new Image();
            previewImg.src = urls[0];
          }
        }
      });
    });
  }

  function renderPage(pageNum) {
    renderSessionId++;
    const sid = renderSessionId;
    if (editMode) {
        renderModCards(modData);
        paginationEl.innerHTML = '';
        return;
    }
    const start = (pageNum - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    const pageData = modData.slice(start, end);
    if (sid !== renderSessionId) return;
    renderModCards(pageData);
    renderPagination(modData.length, pageNum);
    preloadAdjacentPages(pageNum);
}

function openLightbox(src) {
    lightboxImg.src = src;
    lightboxOverlay.classList.add('active');
  }

  async function raceImageWithRetry(urls, maxRetries) {
    maxRetries = maxRetries || 2;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await raceImage(urls);
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await new Promise(function(r) { setTimeout(r, 500); });
        }
      }
    }
    throw lastError;
  }

  async function raceVideoWithRetry(urls, maxRetries) {
    maxRetries = maxRetries || 2;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await raceVideo(urls);
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await new Promise(function(r) { setTimeout(r, 500); });
        }
      }
    }
    throw lastError;
  }

  function switchPreviewTab(tab) {
    activePreviewTab = (activePreviewTab === tab) ? null : tab;
    updatePreviewButtons();
    renderPreviewContent();
  }

  function updatePreviewButtons() {
    const imgActive = activePreviewTab === 'images';
    const vidActive = activePreviewTab === 'videos';
    previewImagesBtn.textContent = imgActive ? '预览图片 ▴' : '预览图片 ▾';
    previewVideosBtn.textContent = vidActive ? '预览视频 ▴' : '预览视频 ▾';
    previewImagesBtn.classList.toggle('active', imgActive);
    previewVideosBtn.classList.toggle('active', vidActive);
  }

  function renderPreviewContent() {
    if (!currentMod) { previewContentArea.innerHTML = ''; return; }
    const mod = currentMod;
    previewContentArea.innerHTML = '<div class="preview-empty-card">正在加载预览资源...</div>';
    if (activePreviewTab === 'images') {
      renderPreviewImages(Array.isArray(mod.previewImages) ? mod.previewImages : []);
    } else if (activePreviewTab === 'videos') {
      renderPreviewVideos(Array.isArray(mod.previewVideos) ? mod.previewVideos : []);
    } else {
      previewContentArea.innerHTML = '';
    }
  }

  async function renderPreviewImages(items) {
    if (items.length === 0) {
      previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置图片资源哦</div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'preview-image-grid';
    previewContentArea.innerHTML = '';
    previewContentArea.appendChild(grid);
    const placeholders = items.map(function() {
      const ph = document.createElement('div');
      ph.className = 'preview-image-item';
      ph.style.background = '#f0f0f0';
      ph.style.aspectRatio = '16/9';
      ph.textContent = '加载中...';
      grid.appendChild(ph);
      return ph;
    });
    await Promise.allSettled(
      items.map(function(item, idx) {
        const urls = toCandidates(item);
        return new Promise(function(resolve) {
          ImageLoadQueue.enqueue(function() {
            return raceImageWithRetry(urls, 2).then(function(url) {
              const img = document.createElement('img');
              img.src = url;
              img.className = 'preview-image-item';
              img.style.cursor = 'zoom-in';
              img.addEventListener('click', function() { openLightbox(url); });
              grid.replaceChild(img, placeholders[idx]);
            }).catch(function() { placeholders[idx].textContent = '加载失败'; }).then(resolve);
          });
        });
      })
    );
  }

  async function renderPreviewVideos(items) {
    if (items.length === 0) {
      previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置视频资源哦</div>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'preview-video-list';
    previewContentArea.innerHTML = '';
    previewContentArea.appendChild(list);
    const currentGen = videoLoadGeneration;
    items.forEach(function(item) {
      const ph = document.createElement('div');
      ph.className = 'preview-video-item';
      ph.style.background = '#f0f0f0';
      ph.style.height = '200px';
      ph.style.display = 'flex';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'center';
      ph.textContent = '视频加载中...';
      list.appendChild(ph);
      let urls = [];
      if (typeof item === 'string') {
        urls = [item];
      } else if (item.urls && Array.isArray(item.urls) && item.urls.length > 0) {
        urls = item.urls;
      } else if (item.url) {
        urls = [item.url];
      }
      if (urls.length === 0) { ph.textContent = '视频链接缺失'; return; }
      VideoLoadQueue.enqueue(function() {
        return new Promise(function(resolve) {
          if (currentGen !== videoLoadGeneration) { resolve(); return; }
          raceVideoWithRetry(urls).then(function(video) {
            if (currentGen !== videoLoadGeneration) { resolve(); return; }
            video.className = 'preview-video-item';
            video.controls = true;
            video.preload = 'metadata';
            if (item.poster) video.poster = item.poster;
            pendingVideos.push(video);
            list.replaceChild(video, ph);
          }).catch(function() { ph.textContent = '视频加载失败'; }).then(resolve);
        });
      });
    });
  }

  previewImagesBtn.addEventListener('click', function() { switchPreviewTab('images'); });
  previewVideosBtn.addEventListener('click', function() { switchPreviewTab('videos'); });

    async function openModal(mod){
currentMod=mod;

if(editMode){
modalTitle.innerHTML='';
var ts=document.createElement('span');
ts.className='editable-field';
ts.contentEditable='true';
ts.textContent=mod.title||'';
ts.addEventListener('blur',function(){mod.title=ts.textContent.trim();saveEditData();});
ts.addEventListener('click',function(e){e.stopPropagation();});
modalTitle.appendChild(ts);
var eb=document.createElement('span');
eb.className='modal-edit-badge';
eb.textContent='可编辑';
modalTitle.appendChild(eb);
}else{
modalTitle.textContent=mod.title;
}

const modalCoverWrap=document.getElementById('modalCoverWrap');
const modalCoverImg=document.getElementById('modalCoverImg');
let modalCoverSrc='';
if(mod.coverImage){
if(Array.isArray(mod.coverImage))modalCoverSrc=mod.coverImage[0]||'';
else modalCoverSrc=mod.coverImage;
}
const hasModalCover=modalCoverSrc.trim()!=='';
if(hasModalCover){
modalCoverImg.src=modalCoverSrc;
modalCoverImg.style.objectFit='cover';
modalCoverImg.style.cursor='zoom-in';
modalCoverImg.onclick=function(e){e.stopPropagation();openLightbox(modalCoverImg.src);};
modalCoverWrap.style.display='block';
modalCoverImg.style.display='block';
}else{
modalCoverWrap.style.display='none';
modalCoverImg.src='';
modalCoverImg.onclick=null;
}

if(editMode){
modalRid.innerHTML='';
var rs=document.createElement('span');
rs.className='editable-field';
rs.contentEditable='true';
rs.textContent=mod.id||'';
rs.addEventListener('blur',function(){
mod.id=rs.textContent.trim();
mod.date=extractDateFromRid(mod.id);
saveEditData();
});
rs.addEventListener('click',function(e){e.stopPropagation();});
modalRid.appendChild(rs);
var regenBtn=document.createElement('button');
regenBtn.className='modal-rid-regen-btn';
regenBtn.textContent='🔄 重新生成RID';
regenBtn.addEventListener('click',function(e){
e.stopPropagation();
var newId=generateModId();
rs.textContent=newId;
mod.id=newId;
mod.date=extractDateFromRid(newId);
saveEditData();
showToast('RID与日期已重新生成');
});
modalRid.appendChild(regenBtn);
modalRid.onclick=null;
ridDropdown.style.display='none';
}else{
modalRid.textContent='RID: '+(mod.id||'无');
modalRid.onclick=function(e){
e.stopPropagation();
const isVisible=ridDropdown.style.display==='block';
ridDropdown.style.display=isVisible?'none':'block';
};
ridDropdown.querySelectorAll('.rid-option').forEach(function(btn){
btn.onclick=function(e){
e.stopPropagation();
const action=btn.dataset.action;
if(action==='copy-rid'){
copyText('RID:'+(mod.id||'')).then(function(){showToast('RID 已复制，快分享给小伙伴吧~');}).catch(function(){showToast('复制失败，请手动复制');});
}else if(action==='copy-link'){
copyText('https://'+SITE_DOMAIN+'/?rid='+(mod.id||'')).then(function(){showToast('帖子链接已复制~');}).catch(function(){showToast('复制失败，请手动复制');});
}
ridDropdown.style.display='none';
};
});
}

modalTags.innerHTML='';
if(mod.tags&&Array.isArray(mod.tags)){
mod.tags.forEach(function(tag,idx){
const span=document.createElement('span');
span.className='modal-tag '+tag.toLowerCase();
span.textContent=tag;
if(editMode){
var db=document.createElement('span');
db.textContent=' \u00d7';
db.style.cssText='cursor:pointer;margin-left:4px;color:#b14b4b;font-weight:700';
db.addEventListener('click',function(e){e.stopPropagation();mod.tags.splice(idx,1);saveEditData();openModal(mod);});
span.appendChild(db);
}
modalTags.appendChild(span);
});
}
if(editMode){
var atb=document.createElement('button');
atb.className='modal-edit-add-btn';
atb.textContent='+ 标签';
atb.addEventListener('click',async function(){
var t=await showEditPopup('输入新标签','');
if(t){if(!mod.tags)mod.tags=[];mod.tags.push(t);saveEditData();openModal(mod);}
});
modalTags.appendChild(atb);
}

let desc=(mod.description||'暂无介绍')
.replace(/&/g,'&amp;')
.replace(/</g,'&lt;')
.replace(/>/g,'&gt;')
.replace(/\n/g,'<br>');
const urlRegex=/(https?:\/\/[^\s<<"]+)/g;
desc=desc.replace(urlRegex,'<a href="$1" target="_blank" rel="noopener noreferrer" class="desc-link">$1</a>');

if(editMode){
modalDescText.innerHTML='';
var dd=document.createElement('div');
dd.className='editable-field';
dd.contentEditable='true';
dd.innerHTML=desc;
dd.style.lineHeight='1.7';
dd.addEventListener('blur',function(){mod.description=dd.innerText;saveEditData();});
dd.addEventListener('click',function(e){e.stopPropagation();});
modalDescText.appendChild(dd);
modalDescText.classList.add('expanded');
descToggle.style.display='none';
}else{
modalDescText.innerHTML=desc;
modalDescText.classList.remove('expanded');
descToggle.style.display='none';
descToggle.textContent='展开全文';
}

if(editMode){
modalAuthor.innerHTML='';
modalAuthor.appendChild(document.createTextNode('作者：'));
var as=document.createElement('span');
as.className='editable-field';
as.contentEditable='true';
as.textContent=mod.author||'';
as.addEventListener('blur',function(){mod.author=as.textContent.trim();saveEditData();});
as.addEventListener('click',function(e){e.stopPropagation();});
modalAuthor.appendChild(as);
}else{
modalAuthor.textContent='作者：'+(mod.author||'佚名');
}

modalLinks.innerHTML='';
if(editMode){
var la=[];
if(mod.authorLinks){
if(Array.isArray(mod.authorLinks))la=mod.authorLinks.slice();
else{
[{name:'Twitter',key:'twitter'},{name:'Pixiv',key:'pixiv'},{name:'Bilibili',key:'bilibili'}].forEach(function(m){
if(mod.authorLinks[m.key])la.push({text:m.name,url:mod.authorLinks[m.key]});
});
}
}
var lc=document.createElement('div');
lc.style.cssText='display:flex;flex-direction:column;gap:6px';
la.forEach(function(link,idx){
var row=document.createElement('div');
row.className='modal-link-edit-row';
var t1=document.createElement('span');
t1.className='editable-field';
t1.contentEditable='true';
t1.textContent=link.text||'';
t1.style.cssText='min-width:50px;max-width:80px';
t1.addEventListener('blur',function(){link.text=t1.textContent.trim();if(!Array.isArray(mod.authorLinks))mod.authorLinks=la;saveEditData();});
t1.addEventListener('click',function(e){e.stopPropagation();});
var u1=document.createElement('span');
u1.className='editable-field';
u1.contentEditable='true';
u1.textContent=link.url||'';
u1.style.minWidth='100px';
u1.addEventListener('blur',function(){link.url=u1.textContent.trim();if(!Array.isArray(mod.authorLinks))mod.authorLinks=la;saveEditData();});
u1.addEventListener('click',function(e){e.stopPropagation();});
var db=document.createElement('button');
db.className='modal-link-edit-delete';
db.innerHTML='&times;';
db.addEventListener('click',function(){la.splice(idx,1);mod.authorLinks=la;saveEditData();openModal(mod);});
row.appendChild(t1);
row.appendChild(document.createTextNode(': '));
row.appendChild(u1);
row.appendChild(db);
lc.appendChild(row);
});
var alb=document.createElement('button');
alb.className='modal-edit-add-btn';
alb.textContent='+ 作者链接';
alb.addEventListener('click',async function(){
var t=await showEditPopup('链接文字','');
if(t===null)return;
var u=await showEditPopup('链接URL','');
if(u===null)return;
la.push({text:t||'链接',url:u||''});
mod.authorLinks=la;
saveEditData();
openModal(mod);
});
lc.appendChild(alb);
modalLinks.appendChild(lc);
}else{
if(mod.authorLinks){
if(Array.isArray(mod.authorLinks)){
mod.authorLinks.forEach(function(l){
if(l.text&&l.url){
var a=document.createElement('a');
a.className='modal-link';
a.href=l.url;
a.target='_blank';
a.rel='noopener noreferrer';
a.textContent=l.text;
modalLinks.appendChild(a);
}
});
}else{
[{name:'Twitter',url:mod.authorLinks.twitter},{name:'Pixiv',url:mod.authorLinks.pixiv},{name:'Bilibili',url:mod.authorLinks.bilibili}].forEach(function(l){
if(l.url){
var a=document.createElement('a');
a.className='modal-link';
a.href=l.url;
a.target='_blank';
a.rel='noopener noreferrer';
a.textContent=l.name;
modalLinks.appendChild(a);
}
});
}
}
}

downloadButtons.innerHTML='';
var dls=mod.downloadLinks&&mod.downloadLinks.length?mod.downloadLinks:(mod.downloadUrl?[{text:'下载',url:mod.downloadUrl}]:[]);
if(editMode){
var dlc=document.createElement('div');
dlc.style.cssText='display:flex;flex-direction:column;gap:6px';
dls.forEach(function(dl,idx){
var row=document.createElement('div');
row.className='modal-link-edit-row';
var t1=document.createElement('span');
t1.className='editable-field';
t1.contentEditable='true';
t1.textContent=dl.text||'';
t1.style.cssText='min-width:50px;max-width:80px';
t1.addEventListener('blur',function(){dl.text=t1.textContent.trim();saveEditData();});
t1.addEventListener('click',function(e){e.stopPropagation();});
var u1=document.createElement('span');
u1.className='editable-field';
u1.contentEditable='true';
u1.textContent=dl.url||'';
u1.style.minWidth='100px';
u1.addEventListener('blur',function(){dl.url=u1.textContent.trim();saveEditData();});
u1.addEventListener('click',function(e){e.stopPropagation();});
var db=document.createElement('button');
db.className='modal-link-edit-delete';
db.innerHTML='&times;';
db.addEventListener('click',function(){dls.splice(idx,1);mod.downloadLinks=dls;saveEditData();openModal(mod);});
row.appendChild(t1);
row.appendChild(document.createTextNode(': '));
row.appendChild(u1);
row.appendChild(db);
dlc.appendChild(row);
});
if(!mod.downloadLinks)mod.downloadLinks=dls;
var adb=document.createElement('button');
adb.className='modal-edit-add-btn';
adb.textContent='+ 下载链接';
adb.addEventListener('click',async function(){
var t=await showEditPopup('按钮文字','');
if(t===null)return;
var u=await showEditPopup('下载URL','');
if(u===null)return;
dls.push({text:t||'下载',url:u||''});
mod.downloadLinks=dls;
saveEditData();
openModal(mod);
});
dlc.appendChild(adb);
downloadButtons.appendChild(dlc);
}else{
dls.forEach(function(dl){
var b=document.createElement('a');
b.className='download-btn-item';
b.href=dl.url;
b.target='_blank';
b.rel='noopener noreferrer';
b.textContent=dl.text;
downloadButtons.appendChild(b);
});
}

if(editMode){
var es=document.getElementById('editUrlSection');
if(es)es.remove();
var us=document.createElement('div');
us.className='modal-edit-url-section';
us.id='editUrlSection';
if(!Array.isArray(mod.previewImages))mod.previewImages=[];
if(!Array.isArray(mod.previewVideos))mod.previewVideos=[];
if(!Array.isArray(mod.coverImage))mod.coverImage=mod.coverImage?[mod.coverImage]:[];
function buildList(arr,label,onAdd){
var h=document.createElement('h4');
h.textContent=label;
us.appendChild(h);
var c=document.createElement('div');
(function render(){
c.innerHTML='';
arr.forEach(function(it,idx){
var url=(typeof it==='string')?it:((it.urls&&it.urls[0])||it.url||'');
var r=document.createElement('div');
r.className='modal-edit-url-row';
var inp=document.createElement('input');
inp.type='text';
inp.value=url;
inp.placeholder='URL';
inp.addEventListener('blur',function(){
var v=inp.value.trim();
if(typeof arr[idx]==='object'&&arr[idx].urls)arr[idx].urls=v?[v]:[];
else arr[idx]=v;
saveEditData();
});
var del=document.createElement('button');
del.className='modal-link-edit-delete';
del.innerHTML='&times;';
del.addEventListener('click',function(){arr.splice(idx,1);saveEditData();render();});
r.appendChild(inp);
r.appendChild(del);
c.appendChild(r);
});
var ab=document.createElement('button');
ab.className='modal-edit-add-btn';
ab.textContent='+ '+label;
ab.addEventListener('click',onAdd);
c.appendChild(ab);
})();
us.appendChild(c);
}
buildList(mod.previewImages,'预览图片URL',async function(){
var u=await showEditPopup('输入图片URL','');
if(u){mod.previewImages.push(u);saveEditData();openModal(mod);}
});
buildList(mod.previewVideos,'预览视频URL',async function(){
var u=await showEditPopup('输入视频URL','');
if(u){mod.previewVideos.push(u);saveEditData();openModal(mod);}
});
buildList(mod.coverImage,'封面图URL',async function(){
var u=await showEditPopup('输入封面图URL','');
if(u){mod.coverImage.push(u);saveEditData();openModal(mod);}
});
var h4s=us.querySelectorAll('h4');
if(h4s[1])h4s[1].style.marginTop='12px';
if(h4s[2])h4s[2].style.marginTop='12px';
var ps=document.querySelector('.preview-section');
if(ps&&ps.nextSibling)ps.parentNode.insertBefore(us,ps.nextSibling);
else if(ps)ps.parentNode.appendChild(us);
}else{
var es2=document.getElementById('editUrlSection');
if(es2)es2.remove();
}

activePreviewTab=null;
updatePreviewButtons();
renderPreviewContent();

modalOverlay.classList.add('active');
document.body.style.overflow='hidden';
setTimeout(function(){
if(!editMode&&modalDescText.scrollHeight>modalDescText.clientHeight+2){
descToggle.style.display='inline-block';
}
},50);
}

function closeModal(){
modalOverlay.classList.remove('active');
document.body.style.overflow='';
currentMod=null;
activePreviewTab=null;
ridDropdown.style.display='none';
if(!editMode){cleanupPendingVideos();}
const modalCoverImg=document.getElementById('modalCoverImg');
if(modalCoverImg){modalCoverImg.src='';modalCoverImg.onclick=null;}
var es=document.getElementById('editUrlSection');
if(es)es.remove();
if(editMode){renderModCards(modData);paginationEl.innerHTML='';}
}

modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', function(e) { if (e.target === modalOverlay) closeModal(); });
  descToggle.addEventListener('click', function() {
    const expanded = modalDescText.classList.toggle('expanded');
    descToggle.textContent = expanded ? '收起' : '展开全文';
  });
  lightboxClose.addEventListener('click', function() { lightboxOverlay.classList.remove('active'); });
  lightboxOverlay.addEventListener('click', function(e) { if (e.target === lightboxOverlay) lightboxOverlay.classList.remove('active'); });

  document.addEventListener('click', function(e) {
    if (!modalRidWrap.contains(e.target)) {
      ridDropdown.style.display = 'none';
    }
  });

  function handleTagClick(tagText) {
    searchInput.value = tagText;

    filterMods();
    searchInput.focus();
  }

  function attachCardSpinner(cardElement) {
    const coverInner = cardElement.querySelector('.mod-cover-inner');
    const coverImg = coverInner ? coverInner.querySelector('.mod-cover-img') : null;
    if (!coverInner || !coverImg) return;

    if (coverImg.complete && coverImg.naturalWidth > 0) {
      return;
    }

    const spinner = document.createElement('span');
    spinner.className = 'card-spinner';
    const hideSpinner = function() {
      if (spinner.parentNode) {
        spinner.style.display = 'none';
        spinner.remove();
      }
    };

    coverImg.addEventListener('load', hideSpinner, { once: true });
    coverImg.addEventListener('error', hideSpinner, { once: true });

    setTimeout(function() {
      if (coverImg.complete) hideSpinner();
    }, 500);

    coverInner.appendChild(spinner);
  }

  function renderModCards(dataArray){
modGrid.innerHTML='';
if(dataArray.length===0){
modGrid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">没有找到相关MOD</div>';
return;
}
const loaded2Src=window.loaded2GifSrc||FALLBACK_LOADED2;
const fbSvg="data:image/svg+xml;charset=UTF-8,"+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none' stroke='%239a92a5' stroke-width='3'><circle cx='24' cy='24' r='20'/><path d='M24 16v12'/><circle cx='24' cy='32' r='2' fill='%239a92a5'/></svg>");
dataArray.forEach(function(mod){
let coverImgSrc='';
if(mod.coverImage){
if(Array.isArray(mod.coverImage))coverImgSrc=mod.coverImage[0]||'';
else coverImgSrc=mod.coverImage;
}
const hasCoverImg=coverImgSrc.trim()!=='';
const imgSrc=hasCoverImg?fbSvg:loaded2Src;
const imgStyle=hasCoverImg?'object-fit: cover;':'object-fit: contain;';

let tagsHtml='';
if(mod.tags&&mod.tags.length){
tagsHtml='<div class="mod-tag-list">'+mod.tags.map(function(t,i){
return '<span class="mod-tag-item '+t.toLowerCase()+'" data-tag-index="'+i+'">'+t+(editMode?'<span class="tag-delete-btn" data-tag-index="'+i+'"> \u00d7</span>':'')+'</span>';
}).join('')+(editMode?'<button class="mod-tag-add-btn" data-mod-id="'+mod.id+'">+</button>':'')+'</div>';
}else{
tagsHtml='<div class="mod-tag-list">'+(editMode?'<button class="mod-tag-add-btn" data-mod-id="'+mod.id+'">+ 标签</button>':'')+'</div>';
}

var ec=editMode?'<input type="checkbox" class="mod-card-edit-check" '+(selectedCardIds.has(mod.id)?'checked':'')+' data-mod-id="'+mod.id+'"><button class="mod-card-edit-delete" data-mod-id="'+mod.id+'" title="删除">\u00d7</button><button class="mod-card-edit-cover-btn" data-mod-id="'+mod.id+'">换封面</button><button class="mod-card-edit-badge-btn" data-mod-id="'+mod.id+'">Badge</button>':'';

var th,mh;
if(editMode){
th='<div class="mod-title editable-field" contenteditable="true" data-field="title" data-mod-id="'+mod.id+'">'+(mod.title||'')+'</div>';
mh='<div class="mod-meta"><span class="mod-meta-tag">大小 <span class="editable-field" contenteditable="true" data-field="size" data-mod-id="'+mod.id+'">'+(mod.size||'')+'</span></span><span class="mod-meta-tag">日期 <span class="editable-field" contenteditable="true" data-field="date" data-mod-id="'+mod.id+'">'+(mod.date||'')+'</span></span></div>';
}else{
th='<div class="mod-title">'+mod.title+'</div>';
mh='<div class="mod-meta"><span class="mod-meta-tag">大小 '+mod.size+'</span><span class="mod-meta-tag">日期 '+mod.date+'</span></div>';
}

const card=document.createElement('div');
card.className='mod-card'+(editMode?' edit-mode':'');
card.dataset.modId=mod.id;
card.innerHTML=
'<div class="mod-cover">'+
'<div class="mod-cover-inner">'+
'<div class="mod-cover-gradient" style="background:'+mod.coverGradient+';"></div>'+
'<img src="'+imgSrc+'" alt="'+mod.title+'" class="mod-cover-img"'+
' style="position:absolute; width:100%; height:100%; '+imgStyle+' z-index:2; border-radius:inherit;"'+
' onerror="this.onerror=null; this.src=\''+fbSvg+'\'; this.style.opacity=0.4;">'+
'</div>'+
'<span class="mod-badge '+mod.badgeClass+'">'+mod.badge+'</span>'+ec+
'</div>'+
'<div class="mod-info">'+
th+tagsHtml+mh+
'<button class="mod-download-btn view-detail-btn">查看详情</button>'+
'</div>';

const coverImgEl=card.querySelector('.mod-cover-img');
if(coverImgEl&&hasCoverImg){
coverImgEl.addEventListener('click',function(e){
e.stopPropagation();
if(coverImgEl.src&&coverImgEl.src.indexOf('data:image/svg')===-1)openLightbox(coverImgEl.src);
});
ImageLoadQueue.enqueue(function(){
return new Promise(function(resolve){
const img=new Image();
img.onload=function(){coverImgEl.src=coverImgSrc;resolve();};
img.onerror=function(){resolve();};
img.src=coverImgSrc;
});
});
}

card.querySelector('.view-detail-btn').addEventListener('click',function(e){e.stopPropagation();openModal(mod);});

if(!editMode){
card.querySelectorAll('.mod-tag-item').forEach(function(tagEl){
tagEl.addEventListener('click',function(e){e.stopPropagation();handleTagClick(tagEl.textContent);});
});
}

if(editMode){
var chk=card.querySelector('.mod-card-edit-check');
chk.addEventListener('change',function(e){
e.stopPropagation();
if(e.target.checked)selectedCardIds.add(mod.id);
else selectedCardIds.delete(mod.id);
updateExportSelectedBtn();
});
chk.addEventListener('click',function(e){e.stopPropagation();});

card.querySelector('.mod-card-edit-delete').addEventListener('click',function(e){
e.stopPropagation();
if(confirm('确定删除"'+mod.title+'"吗？')){
modData=modData.filter(function(m){return m.id!==mod.id;});
baseModData=modData;
selectedCardIds.delete(mod.id);
saveEditData();
renderModCards(modData);
paginationEl.innerHTML='';
}
});

card.querySelector('.mod-card-edit-cover-btn').addEventListener('click',async function(e){
e.stopPropagation();
var cu=Array.isArray(mod.coverImage)?(mod.coverImage[0]||''):(mod.coverImage||'');
var u=await showEditPopup('输入封面图URL',cu);
if(u!==null){mod.coverImage=u?[u]:[];saveEditData();renderModCards(modData);paginationEl.innerHTML='';}
});

card.querySelector('.mod-card-edit-badge-btn').addEventListener('click',async function(e){
e.stopPropagation();
var nb=await showEditPopup('输入Badge文字',mod.badge||'');
if(nb!==null){mod.badge=nb;saveEditData();renderModCards(modData);paginationEl.innerHTML='';}
});

card.querySelectorAll('.tag-delete-btn').forEach(function(b){
b.addEventListener('click',function(e){
e.stopPropagation();
var i=parseInt(b.dataset.tagIndex);
if(mod.tags){mod.tags.splice(i,1);saveEditData();renderModCards(modData);paginationEl.innerHTML='';}
});
});

card.querySelectorAll('.mod-tag-add-btn').forEach(function(b){
b.addEventListener('click',async function(e){
e.stopPropagation();
var t=await showEditPopup('输入新标签','');
if(t){if(!mod.tags)mod.tags=[];mod.tags.push(t);saveEditData();renderModCards(modData);paginationEl.innerHTML='';}
});
});

card.querySelectorAll('.editable-field').forEach(function(el){
el.addEventListener('blur',function(){
var f=el.dataset.field,mid=el.dataset.modId;
var mi=modData.find(function(m){return m.id===mid;});
if(!mi)return;
var v=el.textContent.trim();
if(f==='title')mi.title=v;
else if(f==='size')mi.size=v;
else if(f==='date')mi.date=v;
saveEditData();
});
el.addEventListener('click',function(e){e.stopPropagation();});
el.addEventListener('mousedown',function(e){e.stopPropagation();});
});
}

modGrid.appendChild(card);
attachCardSpinner(card);
});
}

async function performGlobalRidSearch(rid) {
    const categories = ['all', 'skin'];

    for (const cat of categories) {
      if (allSiteData[cat]) {
        const found = allSiteData[cat].find(function(m) { return m.id === rid; });
        if (found) return found;
      }
    }

    for (const cat of categories) {
      if (!allSiteData[cat]) {
        await loadAllDataForCategory(cat);
      }
      if (allSiteData[cat]) {
        const found = allSiteData[cat].find(function(m) { return m.id === rid; });
        if (found) return found;
      }
    }
    return null;
  }

  function filterMods(){
let filtered=baseModData.slice();
const query=searchInput.value.trim();
if(query){
const lowerQuery=query.toLowerCase();
if(lowerQuery.startsWith('rid:')){
const ridPart=lowerQuery.slice(4).trim();
performGlobalRidSearch(ridPart).then(function(found){
if(found){
openModal(found);
searchInput.value='';
searchDropdown.classList.remove('active');
}else{
modGrid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">未找到该 RID</div>';
paginationEl.innerHTML='';
}
});
return;
}else if(/^\d+$/.test(query)){
performGlobalRidSearch(query).then(function(found){
if(found){
openModal(found);
searchInput.value='';
searchDropdown.classList.remove('active');
}else{
modGrid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">未找到该 RID</div>';
paginationEl.innerHTML='';
}
});
return;
}else{
filtered=filtered.filter(function(m){
if(m.title.toLowerCase().includes(lowerQuery))return true;
if(m.tags&&m.tags.some(function(tag){return tag.toLowerCase().includes(lowerQuery);}))return true;
return false;
});
}
}
currentPage=1;
modData=filtered;
if(editMode){
renderModCards(filtered);
paginationEl.innerHTML='';
}else{
renderPage(1);
}
updateSearchDropdown(query);
}

function updateSearchDropdown(query) {
    searchDropdown.innerHTML = '';
    if (!query || query.length < 1) { searchDropdown.classList.remove('active'); return; }
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('rid:') || /^\d+$/.test(query)) { searchDropdown.classList.remove('active'); return; }
    const matches = modData.filter(function(m) {
      if (m.title.toLowerCase().includes(lowerQuery)) return true;
      if (m.tags && m.tags.some(function(tag) { return tag.toLowerCase().includes(lowerQuery); })) return true;
      return false;
    });
    if (matches.length === 0) {
      searchDropdown.innerHTML = '<li style="padding:16px;text-align:center;color:var(--text-muted);">没有找到相关MOD</li>';
    } else {
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('(' + escapedQuery + ')', 'gi');
      matches.slice(0, 8).forEach(function(m) {
        const li = document.createElement('li');
        li.className = 'search-dropdown-item';
        li.innerHTML = m.title.replace(regex, '<mark>$1</mark>');
        li.addEventListener('click', function() { searchInput.value = m.title; searchDropdown.classList.remove('active'); filterMods(); });
        searchDropdown.appendChild(li);
      });
    }
    searchDropdown.classList.add('active');
  }

  async function loadModData(categoryKey){
categoryKey=categoryKey||'all';
currentPage=1;
const loaded2Src=window.loaded2GifSrc||FALLBACK_LOADED2;
modGrid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px;"><img src="'+loaded2Src+'" alt="加载中" style="max-width:200px;"></div>';
paginationEl.innerHTML='';

let loadedData=[];
const manifest=await loadManifest(categoryKey);
const dirMap={all:'sts2_mods',skin:'O.o_interface'};
const dir=dirMap[categoryKey];

if(manifest&&manifest[dir]){
loadedData=await loadAllDataForCategory(categoryKey);
}else{
const url=dataSources[categoryKey];
if(!url)return;
try{
if(dataCache[url]){
loadedData=dataCache[url];
}else{
const controller=new AbortController();
const timeoutId=setTimeout(function(){controller.abort();},8000);
const response=await fetch(url,{signal:controller.signal});
clearTimeout(timeoutId);
if(!response.ok)throw new Error('加载失败');
let rawData=await response.json();
rawData=sortModsByTimeId(rawData);
loadedData=rawData;
dataCache[url]=loadedData;
}
}catch(error){
modGrid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px;">MOD数据加载失败，请稍后再试</div>';
return;
}
}

const ed=loadEditData(categoryKey);
if(ed){
loadedData=ed;
allSiteData[categoryKey]=ed;
}

modData=loadedData;
baseModData=loadedData;
searchInput.value='';
searchDropdown.classList.remove('active');

if(editMode){
renderModCards(modData);
paginationEl.innerHTML='';
}else{
renderPage(1);
}
}

document.getElementById('categoryTags').addEventListener('click', function(e) {
    const tag = e.target.closest('.category-tag');
    if (!tag) return;
    document.querySelectorAll('.category-tag').forEach(function(t) { t.classList.remove('active'); });
    tag.classList.add('active');
    activeCategory = tag.getAttribute('data-category') || 'all';
    loadModData(activeCategory);
  });

  searchInput.addEventListener('input', filterMods);
  searchInput.addEventListener('focus', function() {
    if (searchInput.value.trim().length >= 1) updateSearchDropdown(searchInput.value.trim());
  });
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { searchDropdown.classList.remove('active'); searchInput.blur(); }
    if (e.key === 'Enter') { searchDropdown.classList.remove('active'); filterMods(); }
  });
  document.addEventListener('click', function(e) {
    if (!searchContainer.contains(e.target)) searchDropdown.classList.remove('active');
  });

  charaClose.addEventListener('click', function() { charaOverlay.classList.remove('active'); });
  charaOverlay.addEventListener('click', function(e) { if (e.target === charaOverlay) charaOverlay.classList.remove('active'); });

  function openCharaDetail() {
    if (logoImg.src && logoImg.style.display !== 'none') { charaImg.src = logoImg.src; }
    else { charaImg.src = ''; }
    charaOverlay.classList.add('active');
  }

    async function handleUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const rid = params.get('rid');
    if (rid) {
      const found = await performGlobalRidSearch(rid);
      if (found) {
        openModal(found);
      } else {
        showToast('未找到该帖子');
      }

      history.replaceState({}, document.title, window.location.pathname);
    }
  }

    async function initPage() {
    let loadingGifUrls = [
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded.gif'
    ];
    let logoUrls = [
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/Lihui.gif'
    ];
    let loaded2GifUrls = [
      'http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0',
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif',
      'https://cdn.jsdelivr.net/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif'
    ];

    try {
      const fetchWithTimeout = Promise.race([
        fetch('resources/json/config.json', { cache: 'no-store' }),
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 3000); })
      ]);
      const resp = await fetchWithTimeout;
      if (resp.ok) {
        const config = await resp.json();
        if (config.loadingGifUrls && config.loadingGifUrls.length) loadingGifUrls = config.loadingGifUrls;
        if (config.logoUrls && config.logoUrls.length) logoUrls = config.logoUrls;
        if (config.loaded2GifUrls && config.loaded2GifUrls.length) loaded2GifUrls = config.loaded2GifUrls;
      }
    } catch (e) {}

    const gifPromise = raceImage(loadingGifUrls).catch(function() { return null; });

    const logoPromise = (async function loadLogoWithRetry() {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await raceImage(logoUrls);
        } catch (err) {
          lastErr = err;
          if (attempt < 2) {
            await new Promise(function(resolve) { setTimeout(resolve, 2000); });
          }
        }
      }
      return null;
    })();

    const loaded2Promise = raceImage(loaded2GifUrls).catch(function() { return null; });

    (async function preloadCampaign() {
      try {
        const [allData, skinData] = await Promise.all([
          loadAllDataForCategory('all'),
          loadAllDataForCategory('skin')
        ]);

        const allMods = allData.concat(skinData);
        const coverUrls = [];
        const previewImgUrls = [];

        const PRELOAD_PAGES = 2;
        const PRELOAD_DEPTH = ITEMS_PER_PAGE * PRELOAD_PAGES;

        allMods.forEach(function(mod, idx) {
          if (mod.coverImage) {
            const url = Array.isArray(mod.coverImage) ? (mod.coverImage[0] || '') : mod.coverImage;
            if (url.trim()) coverUrls.push(url);
          }

          if (idx < PRELOAD_DEPTH && Array.isArray(mod.previewImages)) {
            mod.previewImages.slice(0, 4).forEach(function(item) {
              const urls = toCandidates(item);
              if (urls.length && urls[0]) previewImgUrls.push(urls[0]);
            });
          }
        });

        preloadImagesWithConcurrency(coverUrls.concat(previewImgUrls), 10);
      } catch (e) {
      }
    })();

    gifPromise.then(function(src) {
      if (src) {
        loadingGif.src = src;
        loadingGif.style.display = 'block';
        if (potionWrapper) potionWrapper.style.display = 'none';
      }
    });
    logoPromise.then(function(src) {
      if (src) {
        logoImg.src = src;
        logoImg.style.display = 'block';
        logoTower.style.display = 'none';
      }
    });
    loaded2Promise.then(function(src) {
      if (src) window.loaded2GifSrc = src;
    });

    setTimeout(function() {
      loadingOverlay.classList.add('hidden');
      mainContent.style.opacity = '1';
      loadModData('all');
    }, 10000);

    logoArea.addEventListener('click', function(e) {
      if (e.target === logoArea || e.target === logoImg || e.target.closest('.logo-img') || e.target.closest('.logo-tower')) {
        openCharaDetail();
      }
    });

    handleUrlParams();
  }

editFab.addEventListener('click', toggleEditMode);
editExit.addEventListener('click', function() {
  editMode = false; editCollapsed = false;
  editFab.classList.remove('active');
  editToolbar.style.display = 'none';
  editToolbarMini.style.display = 'none';
  document.body.classList.remove('edit-mode-active');
  selectedCardIds.clear();
  loadModData(activeCategory);
  showToast('已退出编辑模式');
});
editAddMod.addEventListener('click', addNewMod);
editSelectAll.addEventListener('click', function() {
  modData.forEach(function(m) { selectedCardIds.add(m.id); });
  updateExportSelectedBtn();
  renderModCards(modData);
  paginationEl.innerHTML = '';
});
editDeselectAll.addEventListener('click', function() {
  selectedCardIds.clear();
  updateExportSelectedBtn();
  renderModCards(modData);
  paginationEl.innerHTML = '';
});
editClearData.addEventListener('click', function() {
  if (confirm('确定要清除当前分类的本地编辑数据吗？')) {
    clearEditData(activeCategory);
    dataCache = {};
    allSiteData = {};
    loadModData(activeCategory);
    showToast('编辑数据已清除');
  }
});
editImportJSON.addEventListener('click', function() {
  importJSON();
});
editImportZip.addEventListener('click', function() {
  importZip();
});
editFileList.addEventListener('click', function() {
  toggleSidebar();
});
editSaveLocal.addEventListener('click', function() {
  saveAllToLocal();
});
editLoadLocal.addEventListener('click', function() {
  loadAllFromLocal();
});
editSidebarClose.addEventListener('click', function() {
  toggleSidebar();
});
editSidebarExportZip.addEventListener('click', function() {
  exportZip();
});
editExportAll.addEventListener('click', function() {
  exportZip();
});
editExportSelected.addEventListener('click', function() {
  if (!selectedCardIds.size) return;
  var sel = modData.filter(function(m) { return selectedCardIds.has(m.id); });
  var cn = activeCategory === 'all' ? 'sts2_mods' : 'O_o_interface';
  exportJSON(sel, getExportFilename(cn + '_selected_' + sel.length));
  showToast('已导出 ' + sel.length + ' 条选中数据');
});
editCollapse.addEventListener('click', function() {
  editCollapsed = true;
  editToolbar.style.display = 'none';
  editToolbarMini.style.display = 'block';
  document.body.classList.remove('edit-mode-active');
});
editToolbarMini.addEventListener('click', function() {
  editCollapsed = false;
  editToolbar.style.display = 'flex';
  editToolbarMini.style.display = 'none';
  document.body.classList.add('edit-mode-active');
});
editPopupCancel.addEventListener('click', function() {
  editPopupOverlay.style.display = 'none';
  if (editPopupResolve) editPopupResolve(null);
  editPopupResolve = null;
});
editPopupConfirm.addEventListener('click', function() {
  editPopupOverlay.style.display = 'none';
  var v = editPopupInput.value.trim();
  if (editPopupResolve) editPopupResolve(v || null);
  editPopupResolve = null;
});
editPopupInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') editPopupConfirm.click();
  else if (e.key === 'Escape') editPopupCancel.click();
});
editPopupOverlay.addEventListener('click', function(e) {
  if (e.target === editPopupOverlay) {
    editPopupOverlay.style.display = 'none';
    if (editPopupResolve) editPopupResolve(null);
    editPopupResolve = null;
  }
});
document.addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.shiftKey && e.key === 'E') { e.preventDefault(); toggleEditMode(); }
});



  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }
})();
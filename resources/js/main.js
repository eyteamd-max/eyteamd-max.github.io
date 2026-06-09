
(function () {
  // ===== 视频/图片加载队列（保留原站） =====
  var VideoLoadQueue = {
    maxConcurrent: 2,
    running: 0,
    queue: [],
    taskIdCounter: 0,
    activeTasks: {},
    enqueue: function (taskFn) {
      var taskId = ++this.taskIdCounter;
      var self = this;
      return new Promise(function (resolve, reject) {
        self.activeTasks[taskId] = { resolve: resolve, reject: reject, cancelled: false };
        self.queue.push({
          taskId: taskId,
          run: function () {
            if (!self.activeTasks[taskId] || self.activeTasks[taskId].cancelled) {
              delete self.activeTasks[taskId];
              self.running--;
              self._next();
              return;
            }
            taskFn().then(function (result) {
              if (!self.activeTasks[taskId]) { self.running--; self._next(); return; }
              if (self.activeTasks[taskId].cancelled) { delete self.activeTasks[taskId]; self.running--; self._next(); return; }
              self.activeTasks[taskId].resolve(result);
              delete self.activeTasks[taskId];
              self.running--;
              self._next();
            }).catch(function (err) {
              if (!self.activeTasks[taskId]) { self.running--; self._next(); return; }
              if (self.activeTasks[taskId].cancelled) { delete self.activeTasks[taskId]; self.running--; self._next(); return; }
              self.activeTasks[taskId].reject(err);
              delete self.activeTasks[taskId];
              self.running--;
              self._next();
            });
          }
        });
        self._next();
      });
    },
    _next: function () {
      while (this.running < this.maxConcurrent && this.queue.length > 0) {
        var task = this.queue.shift();
        this.running++;
        task.run();
      }
    },
    cancelAll: function () {
      this.queue = [];
      for (var id in this.activeTasks) {
        if (this.activeTasks.hasOwnProperty(id)) {
          this.activeTasks[id].cancelled = true;
        }
      }
    }
  };

  var ImageLoadQueue = {
    maxConcurrent: 4,
    running: 0,
    queue: [],
    enqueue: function (taskFn) {
      var self = this;
      return new Promise(function (resolve, reject) {
        self.queue.push({ fn: taskFn, resolve: resolve, reject: reject });
        self._next();
      });
    },
    _next: function () {
      var self = this;
      while (self.running < self.maxConcurrent && self.queue.length > 0) {
        var item = self.queue.shift();
        self.running++;
        item.fn().then(function (result) {
          item.resolve(result);
          self.running--;
          self._next();
        }).catch(function (err) {
          item.reject(err);
          self.running--;
          self._next();
        });
      }
    }
  };

  var pendingVideos = [];
  var videoLoadGeneration = 0;
  var renderSessionId = 0;

  function cleanupPendingVideos() {
    if (pendingVideos.length === 0) return;
    var videos = pendingVideos.slice();
    pendingVideos = [];
    videos.forEach(function (v) {
      v.onloadedmetadata = v.onloadeddata = v.onerror = null;
      v.removeAttribute('src');
      v.load();
    });
  }

  function raceImage(urls, timeout) {
    timeout = timeout || 3500;
    if (!urls || urls.length === 0) return Promise.reject('no urls');

    var timeoutPromise = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error('image load timeout'));
      }, timeout);
    });

    var loadPromises = urls.map(function (url) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        var stallTimer = setTimeout(function () {
          reject(new Error('image load stalled'));
        }, timeout + 2000);

        img.onload = img.onerror = function (e) {
          clearTimeout(stallTimer);
          if (e.type === 'load') resolve(url);
          else reject(new Error('image load failed'));
        };

        img.src = url;
      });
    });

    return Promise.race([
      Promise.any([timeoutPromise].concat(loadPromises)),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('total timeout'));
        }, timeout + 3000);
      })
    ]);
  }

  function raceVideo(urls) {
    if (!urls || urls.length === 0) return Promise.reject('no urls');

    var videos = [];
    var promises = urls.map(function (url) {
      return new Promise(function (resolve, reject) {
        var video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;

        var timer = setTimeout(function () {
          var pIdx = pendingVideos.indexOf(video);
          if (pIdx !== -1) pendingVideos.splice(pIdx, 1);
          reject(new Error('video load stalled'));
        }, 5000);

        video.onloadedmetadata = function () {
          clearTimeout(timer);
          var pIdx = pendingVideos.indexOf(video);
          if (pIdx !== -1) pendingVideos.splice(pIdx, 1);
          resolve({ url: url, video: video });
        };
        video.onerror = function () {
          clearTimeout(timer);
          var pIdx = pendingVideos.indexOf(video);
          if (pIdx !== -1) pendingVideos.splice(pIdx, 1);
          reject(new Error('video load failed'));
        };

        video.src = url;
        videos.push(video);
        pendingVideos.push(video);
      });
    });

    return Promise.any(promises).then(function (result) {
      videos.forEach(function (v) {
        if (v !== result.video) {
          v.onloadedmetadata = v.onerror = null;
          v.removeAttribute('src');
          v.load();
        }
      });

      var cleanVideo = result.video.cloneNode(true);
      cleanVideo.muted = true;
      cleanVideo.playsInline = true;
      cleanVideo.preload = 'metadata';

      result.video.onloadedmetadata = result.video.onerror = null;
      result.video.removeAttribute('src');
      result.video.load();

      return cleanVideo;
    }).catch(function (e) {
      videos.forEach(function (v) {
        v.onloadedmetadata = v.onerror = null;
        v.removeAttribute('src');
        v.load();
      });
      throw e;
    });
  }

  function toCandidates(item) {
    if (Array.isArray(item)) return item.length ? item : [item];
    return [item];
  }

  function sortModsByTimeId(dataArray) {
    return dataArray.slice().sort(function (a, b) {
      return (b.id || '').localeCompare(a.id || '');
    });
  }

  function preloadImagesWithConcurrency(urls, concurrency) {
    return new Promise(function (resolve) {
      if (!urls || urls.length === 0) {
        resolve();
        return;
      }

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
        var timer = setTimeout(function () {
          running--;
          next();
        }, 2500);

        img.onload = img.onerror = function () {
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

  // ===== DOM 元素 =====
  var loadingOverlay = document.getElementById('loadingOverlay');
  var loadingGif = document.getElementById('loadingGif');
  var loadingText = document.getElementById('loadingText');
  var potionWrapper = document.getElementById('potionWrapper');
  var mainContent = document.getElementById('mainContent');
  mainContent.style.opacity = '0';
  mainContent.style.transition = 'opacity 0.5s ease';

  var logoImg = document.getElementById('logoImg');
  var logoArea = document.getElementById('logoArea');
  var menuBtn = document.getElementById('menuBtn');
  var menuPanel = document.getElementById('menuPanel');
  var themeToggle = document.getElementById('themeToggle');
  var themeIconSun = document.getElementById('themeIconSun');
  var themeIconMoon = document.getElementById('themeIconMoon');

  var modData = [];
  var baseModData = [];
  var activeCategory = 'all';
  var currentPage = 1;
  var ITEMS_PER_PAGE = 10;
  var allSiteData = {};
  var manifestCache = {};
  var dataLoadingPromises = {};

  var mG = document.getElementById('mG');
  var paginationEl = document.getElementById('pagination');
  var sI = document.getElementById('sI');
  var searchDropdown = document.getElementById('searchDropdown');
  var searchContainer = document.getElementById('searchContainer');
  var mO = document.getElementById('mO');
  var mX = document.getElementById('mX');
  var mC = document.getElementById('mC');
  var lO = document.getElementById('lO');
  var lX = document.getElementById('lX');
  var lI = document.getElementById('lI');
  var tT = document.getElementById('tT');

  var dataSources = {
    all: 'resources/json/post/sts2_mods/sts2_mods_1.json',
    skin: 'resources/json/post/O.o_interface/O.o_interface_1.json'
  };

  var dataCache = {};
  var currentMod = null;
  var activePreviewTab = null;

  var FALLBACK_LOADED2 = 'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif';
  window.loaded2GifSrc = null;

  var SITE_DOMAIN = 'axxxx.cyou';
  var toastTimer;

  // ===== SVG 图标 =====
  var dlS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6M7 10l5 5 5-5M12 15V3"/></svg>';
  var imS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
  var viS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
  var coS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  var shS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

  // ===== 工具函数 =====
  function showToast(message) {
    clearTimeout(toastTimer);
    tT.textContent = message;
    tT.classList.add('sh2');
    toastTimer = setTimeout(function () {
      tT.classList.remove('sh2');
    }, 2200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    } else {
      return new Promise(function (resolve, reject) {
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
          document.execCommand('copy');
          document.body.removeChild(textarea);
          resolve();
        } catch (err) {
          document.body.removeChild(textarea);
          reject(err);
        }
      });
    }
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function gCS(m) {
    if (!m.coverImage) return '';
    if (Array.isArray(m.coverImage)) return m.coverImage[0] || '';
    return m.coverImage;
  }

  function gPI(t, u) {
    t = (t || '').toLowerCase();
    u = (u || '').toLowerCase();
    if (/b站|bilibili/.test(t) || /bilibili|b23\.tv/.test(u)) return { n: 'B站', c: 'tb' };
    if (/twitter|x[（(]/.test(t) || /twitter\.com|x\.com/.test(u)) return { n: 'X', c: 'tx' };
    if (/github/.test(t) || /github\.com/.test(u)) return { n: 'GitHub', c: 'tg' };
    if (/爱发电|ifdian/.test(t) || /ifdian/.test(u)) return { n: '爱发电', c: 'ta' };
    if (/n网|nexus/.test(t) || /nexusmods/.test(u)) return { n: 'N网', c: 'tn' };
    if (/youtube|油管/.test(t) || /youtube\.com/.test(u)) return { n: 'YouTube', c: 'ty' };
    if (/夸克|quark/.test(t) || /quark/.test(u)) return { n: '夸克', c: 'tq' };
    return { n: t, c: '' };
  }

  function gRC(r) {
    r = (r || '').toLowerCase();
    if (/发布|发布者|作者/.test(r)) return 'rp';
    if (/形象|原画|美术|插画|立绘|画师/.test(r)) return 'ra';
    if (/技术|mod|代码|开发|支持|程序/.test(r)) return 'rt';
    return 'rd';
  }

  function pA(s) {
    if (!s) return [];
    if (!/\[[^\]]+\]/.test(s)) return [{ role: '', name: s.trim() }];
    var r = [], m, re = /\[([^\]]+)\]\s*[-－—]\s*([^\[]*?)(?=\s*\[|$)/g;
    while ((m = re.exec(s)) !== null) {
      var ro = m[1].trim(), nm = m[2].trim().replace(/\s+/g, ' ');
      if (nm) r.push({ role: ro, name: nm });
    }
    return r.length ? r : [{ role: '', name: s.trim() }];
  }

  function eNL(t) {
    var p = t.split(/[｜|]/);
    return p.length > 1 ? p.slice(1).join('｜').trim() : t.trim();
  }

  function mLA(a, l) {
    if (!l || !l.length) return a.map(function (x) { return Object.assign({}, x, { links: [] }); });
    if (a.length === 1) return [Object.assign({}, a[0], { links: l })];
    return a.map(function (x) {
      var mt = [];
      l.forEach(function (li) {
        var ln = eNL(li.text);
        if (ln && x.name && (x.name.indexOf(ln) !== -1 || ln.indexOf(x.name) !== -1 || x.name.replace(/[（）()]/g, '').indexOf(ln.replace(/[（）()]/g, '')) !== -1)) mt.push(li);
      });
      return Object.assign({}, x, { links: mt });
    });
  }

  function cLL(ls) {
    var la = [], al = [], hi = [];
    if (!ls || !ls.length) return { latest: la, alternative: al, history: hi };
    ls.forEach(function (l) {
      var t = l.text;
      if (t.includes('兼容') || t.includes('备选') || t.includes('旧版') || t.includes('历史版本')) hi.push(l);
      else if (t.includes('在线解析') || t.includes('N网') || /官方帖子/.test(t)) al.push(l);
      else la.push(l);
    });
    return { latest: la, alternative: al, history: hi };
  }

  function cOF(te, tg) {
    if (te.textContent.length > 40) { tg.style.display = 'inline-block'; return; }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (te.scrollHeight > te.clientHeight + 2) tg.style.display = 'inline-block';
        else tg.style.display = 'none';
      });
    });
  }

  // ===== 数据加载（保留原站） =====
  function parseManifestRange(rangeStr) {
    if (!rangeStr || typeof rangeStr !== 'string') return [];
    var parts = rangeStr.split('~');
    if (parts.length !== 2) return [];
    var start = parseInt(parts[0], 10);
    var end = parseInt(parts[1], 10);
    if (isNaN(start) || isNaN(end)) return [];
    var result = [];
    for (var i = start; i <= end; i++) result.push(i);
    return result;
  }

  async function loadManifest(categoryKey) {
    if (manifestCache[categoryKey]) return manifestCache[categoryKey];

    var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
    var dir = dirMap[categoryKey];
    if (!dir) return null;

    var manifestUrl = 'resources/json/post/' + dir + '/manifest.json';
    try {
      var resp = await fetch(manifestUrl, { cache: 'no-store' });
      if (!resp.ok) return null;
      var data = await resp.json();
      manifestCache[categoryKey] = data;
      return data;
    } catch (e) {
      return null;
    }
  }

  async function loadJsonByManifest(categoryKey, fileIndex) {
    var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
    var dir = dirMap[categoryKey];
    if (!dir) return [];

    var url = 'resources/json/post/' + dir + '/' + dir + '_' + fileIndex + '.json';
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 8000);
      var response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeoutId);
      if (!response.ok) return [];
      var rawData = await response.json();
      rawData = sortModsByTimeId(rawData);
      return rawData;
    } catch (error) {
      return [];
    }
  }

  async function loadAllDataForCategory(categoryKey) {
    if (allSiteData[categoryKey]) return allSiteData[categoryKey];
    if (dataLoadingPromises[categoryKey]) return await dataLoadingPromises[categoryKey];

    var promise = (async function () {
      var manifest = await loadManifest(categoryKey);
      var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
      var dir = dirMap[categoryKey];

      if (manifest && manifest[dir]) {
        var rangeStr = manifest[dir];
        var indices = parseManifestRange(rangeStr);
        var dataArrays = await Promise.all(indices.map(function (idx) {
          return loadJsonByManifest(categoryKey, idx);
        }));
        var allData = dataArrays.flat();
        allSiteData[categoryKey] = allData;
        return allData;
      }

      var url = dataSources[categoryKey];
      if (!url) return [];
      try {
        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, 8000);
        var response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeoutId);
        if (!response.ok) return [];
        var rawData = await response.json();
        rawData = sortModsByTimeId(rawData);
        allSiteData[categoryKey] = rawData;
        return rawData;
      } catch (error) {
        return [];
      }
    })();

    dataLoadingPromises[categoryKey] = promise;
    try {
      var result = await promise;
      return result;
    } finally {
      delete dataLoadingPromises[categoryKey];
    }
  }

  // ===== 预加载（保留原站） =====
  var preloadState = { currentPreloadPage: 0 };

  function extractCoverUrls(dataSlice) {
    var urls = [];
    dataSlice.forEach(function (mod) {
      if (mod.coverImage) {
        var url = Array.isArray(mod.coverImage) ? (mod.coverImage[0] || '') : mod.coverImage;
        if (url.trim()) urls.push(url);
      }
    });
    return urls;
  }

  function extractPreviewImageUrls(dataSlice, maxPerMod) {
    maxPerMod = maxPerMod || 4;
    var urls = [];
    dataSlice.forEach(function (mod) {
      if (Array.isArray(mod.previewImages)) {
        mod.previewImages.slice(0, maxPerMod).forEach(function (item) {
          var candidates = toCandidates(item);
          if (candidates.length && candidates[0]) urls.push(candidates[0]);
        });
      }
    });
    return urls;
  }

  function getPageSlice(dataArray, pageNum) {
    var start = (pageNum - 1) * ITEMS_PER_PAGE;
    var end = start + ITEMS_PER_PAGE;
    return dataArray.slice(start, end);
  }

  function triggerAdjacentPreload(pageNum) {
    var totalPages = Math.ceil(modData.length / ITEMS_PER_PAGE);
    var nextPage = pageNum + 1;
    if (nextPage > totalPages) return;
    if (preloadState.currentPreloadPage >= nextPage) return;

    preloadState.currentPreloadPage = nextPage;
    var nextPageData = getPageSlice(modData, nextPage);
    var coverUrls = extractCoverUrls(nextPageData);

    preloadImagesWithConcurrency(coverUrls, 6).then(function () {
      var previewUrls = extractPreviewImageUrls(nextPageData, 3);
      return preloadImagesWithConcurrency(previewUrls, 4);
    });
  }

  async function priorityPreload() {
    await Promise.all([
      loadAllDataForCategory('all'),
      loadAllDataForCategory('skin')
    ]);

    var defaultData = allSiteData['all'] || [];
    var page1Data = getPageSlice(defaultData, 1);
    var page1Covers = extractCoverUrls(page1Data);
    await preloadImagesWithConcurrency(page1Covers, 6);

    var page2Data = getPageSlice(defaultData, 2);
    var page2Covers = extractCoverUrls(page2Data);
    await preloadImagesWithConcurrency(page2Covers, 6);

    var page1Previews = extractPreviewImageUrls(page1Data, 3);
    await preloadImagesWithConcurrency(page1Previews, 4);

    preloadState.currentPreloadPage = 2;
  }

  // ===== 分页器（保留原站逻辑，适配新样式） =====
  function renderPagination(totalItems, currentPageNum) {
    paginationEl.innerHTML = '';
    var totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    if (totalPages <= 1) return;

    paginationEl.style.display = 'flex';

    function createBtn(type, content, disabled, clickHandler) {
      var btn = document.createElement('button');
      btn.className = type;
      btn.innerHTML = content;
      if (disabled) btn.disabled = true;
      if (clickHandler) btn.addEventListener('click', clickHandler);
      return btn;
    }

    function createPageBtn(pageNum) {
      return createBtn('pagination-page' + (pageNum === currentPageNum ? ' active' : ''),
        pageNum, false, function () {
          currentPage = pageNum;
          renderPage(pageNum);
          mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    function createDots() {
      var span = document.createElement('span');
      span.className = 'pagination-dots';
      span.textContent = '...';
      return span;
    }

    var items = [];

    items.push(createBtn('pagination-btn', '&#8249;', currentPageNum <= 1, function () {
      if (currentPageNum > 1) {
        currentPage--;
        renderPage(currentPage);
        mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }));

    items.forEach(function (item) {
      paginationEl.appendChild(item);
    });

    var gotoWrap = document.createElement('span');
    gotoWrap.className = 'pagination-goto';

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
      mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  function renderPage(pageNum) {
    var start = (pageNum - 1) * ITEMS_PER_PAGE;
    var end = start + ITEMS_PER_PAGE;
    var pageData = modData.slice(start, end);
    renderModCards(pageData);
    renderPagination(modData.length, pageNum);

    setTimeout(function () {
      triggerAdjacentPreload(pageNum);
    }, 300);
  }

  // ===== 新版卡片渲染（参考版本） =====
  function renderModCards(dataArray) {
    mG.innerHTML = '';
    if (dataArray.length === 0) {
      mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--tm)">没有找到相关MOD</div>';
      return;
    }

    dataArray.forEach(function (mod) {
      var c = document.createElement('div');
      c.className = 'cd';
      c.dataset.modId = mod.id;
      var cs = gCS(mod);
      var ch = cs
        ? '<img src="' + cs + '" alt="' + esc(mod.title) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'"><div class="cp" style="display:none">📦</div>'
        : '<div class="cp">📦</div>';
      var MX = 4, tg = mod.tags || [], vt = tg.slice(0, MX), ec = tg.length - MX;
      var th = vt.map(function (t) {
        return '<span class="ti ' + t.toLowerCase() + '">' + esc(t) + '<span class="tag-delete-btn" data-tag="' + esc(t) + '">×</span></span>';
      }).join('');
      if (ec > 0) th += '<span class="tm2">+' + ec + '</span>';
      th += '<button class="mod-tag-add-btn" data-mod-id="' + mod.id + '">+ 标签</button>';

      c.innerHTML = '<div class="cv" style="background:' + (mod.coverGradient || 'linear-gradient(135deg,#f5f2f8,#ece7f3)') + '">' + ch + '</div>' +
        '<div class="ci"><div class="tr"><span class="tt">' + esc(mod.title) + '</span><span class="tv">' + esc(mod.badge) + '</span></div>' +
        '<div class="tl">' + th + '</div>' +
        '<div class="mt"><span>' + esc(mod.size) + '</span><span class="md">·</span><span>' + esc(mod.date) + '</span></div></div>';

      c.addEventListener('click', function (e) {
        if (isEditMode) {
          if (e.target.closest('.mod-card-edit-check') || e.target.closest('.mod-card-edit-delete') ||
              e.target.closest('.mod-card-edit-cover-btn') || e.target.closest('.mod-card-edit-badge-btn') ||
              e.target.closest('.mod-card-edit-detail-btn') ||
              e.target.closest('.tag-delete-btn') || e.target.closest('.mod-tag-add-btn') ||
              e.target.closest('[contenteditable="true"]')) {
            return;
          }
          // 编辑模式下，只有点击"查看详情"按钮才进入详情页
          return;
        }
        oM(mod);
      });
      mG.appendChild(c);
    });

    if (isEditMode) {
      attachEditControlsToCards();
    }
  }

  // ===== Lightbox =====
  function oLB(s) {
    lI.src = s;
    lO.classList.add('act');
  }
  lX.addEventListener('click', function () { lO.classList.remove('act'); });
  lO.addEventListener('click', function (e) { if (e.target === lO) lO.classList.remove('act'); });

  // ===== 预览渲染 =====
  function rPI(imgs) {
    if (!imgs || !imgs.length) return '<div class="pe">暂无图片预览资源</div>';
    var h = '<div class="pig">';
    for (var i = 0; i < imgs.length; i++) {
      h += '<img class="pii" src="' + imgs[i] + '" onclick="window._oLB(this.src)" onerror="this.style.display=\'none\'">';
    }
    return h + '</div>';
  }

  function rPV(vids) {
    if (!vids || !vids.length) return '<div class="pe">暂无视频预览资源</div>';
    var h = '<div class="pvl">';
    for (var i = 0; i < vids.length; i++) {
      h += '<video class="pvi" controls preload="metadata" src="' + vids[i] + '"></video>';
    }
    return h + '</div>';
  }

  // ===== 详情模态框（参考版本） =====
  function oM(mod) {
    currentMod = mod;
    var cl = cLL(mod.downloadLinks), h = '';
    var cs = gCS(mod);
    if (cs) h += '<div class="miw"><img class="mii" src="' + cs + '" alt="' + esc(mod.title) + '" onclick="window._oLB(this.src)" onerror="this.parentElement.style.display=\'none\'"></div>';
    h += '<h2 class="mit">' + esc(mod.title) + '</h2>';
    h += '<div class="mml">';
    h += '<span class="mmi">' + esc(mod.badge) + '</span><span class="mms">·</span>';
    h += '<span class="mmi">' + esc(mod.size) + '</span><span class="mms">·</span>';
    h += '<span class="mmi">' + esc(mod.date) + '</span><span class="mms">·</span>';
    h += '<span class="mmi">axxxx.cyou</span>';
    h += '</div>';
    h += '<div class="mrg-wrap">';
    h += '<span class="mr"><span class="mrt">RID ' + mod.id + '</span></span>';
    h += '<a class="mra" onclick="event.preventDefault();window._cPT(\'RID:' + mod.id + '\').then(function(){window._sTM(\'RID已复制\')})" title="复制RID">' + coS + '复制</a>';
    h += '<a class="mra" onclick="event.preventDefault();window._cPT(\'https://axxxx.cyou/?rid=' + mod.id + '\').then(function(){window._sTM(\'分享链接已复制\')})" title="复制分享链接">' + shS + '分享</a>';
    h += '</div>';
    if (mod.tags && mod.tags.length) {
      h += '<div class="mts">';
      mod.tags.forEach(function (t) { h += '<span class="mtg ' + t.toLowerCase() + '">' + esc(t) + '</span>'; });
      h += '</div>';
    }
    h += '<div class="dsl"><span>简介</span></div>';
    var de = (mod.description || '暂无介绍').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    de = de.replace(/(https?:\/\/[^\s<"]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    h += '<div class="mde"><div class="dt" id="dT">' + de + '</div><span class="dto" id="dO" style="display:none">展开全文</span></div>';

    h += '<div class="sl"><span>下载方式</span></div>';
    h += '<div class="dsw ls"><div class="sh" onclick="window._tS(this)"><span class="st">最新版本<span class="sc">(' + cl.latest.length + ')</span></span><span class="sa2 op">▾</span></div><div class="sb"><div class="sbi">';
    if (cl.latest.length) {
      cl.latest.forEach(function (dl, i) {
        h += '<div class="di"><div class="dic"><div class="dih"><span class="dn"><a href="' + dl.url + '" target="_blank" rel="noopener noreferrer">' + esc(dl.text) + '</a></span>';
        var v = dl.version || (i === 0 ? mod.badge : '');
        var s = dl.size || (i === 0 ? mod.size : '');
        var d = dl.date || (i === 0 ? mod.date : '');
        if (v || s || d) {
          var parts = [];
          if (v) parts.push(esc(v));
          if (s) parts.push(esc(s));
          if (d) parts.push(esc(d));
          h += '<span class="dm">' + parts.join(' · ') + '</span>';
        }
        h += '</div>';
        if (dl.desc) h += '<div class="id" id="lD' + i + '">' + esc(dl.desc) + '</div><span class="idt" data-target="lD' + i + '" onclick="window._tID(this)" style="display:none">展开</span>';
        h += '</div><a class="db" href="' + dl.url + '" target="_blank" rel="noopener noreferrer">' + dlS + '下载</a></div>';
      });
    } else {
      h += '<div class="eh">暂无直接下载链接</div>';
    }
    h += '</div></div></div>';

    if (cl.alternative.length) {
      h += '<div class="dsw"><div class="sh" onclick="window._tS(this)"><span class="st">其他下载方式<span class="sc">(' + cl.alternative.length + ')</span></span><span class="sa2">▾</span></div><div class="sb co"><div class="sbi">';
      cl.alternative.forEach(function (dl, i) {
        h += '<div class="di"><div class="dic"><div class="dih"><span class="dn"><a href="' + dl.url + '" target="_blank" rel="noopener noreferrer">' + esc(dl.text) + '</a></span>';
        var av = dl.version || '', as2 = dl.size || '', ad = dl.date || '';
        if (av || as2 || ad) {
          var aparts = [];
          if (av) aparts.push(esc(av));
          if (as2) aparts.push(esc(as2));
          if (ad) aparts.push(esc(ad));
          h += '<span class="dm">' + aparts.join(' · ') + '</span>';
        }
        h += '</div>';
        if (dl.desc) h += '<div class="id" id="aD' + i + '">' + esc(dl.desc) + '</div><span class="idt" data-target="aD' + i + '" onclick="window._tID(this)" style="display:none">展开</span>';
        h += '</div><a class="db" href="' + dl.url + '" target="_blank" rel="noopener noreferrer">' + dlS + '前往</a></div>';
      });
      h += '</div></div></div>';
    }

    h += '<div class="sl"><span>更多</span></div>';
    h += '<div class="dsw"><div class="sh" onclick="window._tS(this)"><span class="st">历史版本<span class="sc">' + (cl.history.length ? '(' + cl.history.length + ')' : '') + '</span></span><span class="sa2">▾</span></div><div class="sb co"><div class="sbi">';
    if (cl.history.length) {
      cl.history.forEach(function (dl, i) {
        h += '<div class="di"><div class="dic"><div class="dih"><span class="dn"><a href="' + dl.url + '" target="_blank" rel="noopener noreferrer">' + esc(dl.text) + '</a></span>';
        var hv = dl.version || '', hs = dl.size || '', hd = dl.date || '';
        if (hv || hs || hd) {
          var hparts = [];
          if (hv) hparts.push(esc(hv));
          if (hs) hparts.push(esc(hs));
          if (hd) hparts.push(esc(hd));
          h += '<span class="dm">' + hparts.join(' · ') + '</span>';
        }
        h += '</div>';
        if (dl.desc) h += '<div class="id" id="hD' + i + '">' + esc(dl.desc) + '</div><span class="idt" data-target="hD' + i + '" onclick="window._tID(this)" style="display:none">展开</span>';
        h += '</div><a class="db" href="' + dl.url + '" target="_blank" rel="noopener noreferrer">' + dlS + '下载</a></div>';
      });
    } else {
      h += '<div class="eh">暂无历史版本</div>';
    }
    h += '</div></div></div>';

    var au = pA(mod.author || '佚名'), awl = mLA(au, mod.authorLinks || []), is = awl.length === 1 && !awl[0].role;
    h += '<div class="sl"><span>作者</span></div><div class="as' + (is ? ' sa' : '') + '">';
    awl.forEach(function (a) {
      h += '<div class="ar">';
      if (a.role) h += '<span class="arl ' + gRC(a.role) + '">' + esc(a.role) + '</span>';
      h += '<span class="an">' + esc(a.name) + '</span>';
      if (a.links && a.links.length) {
        a.links.forEach(function (l) {
          var p = gPI(l.text, l.url);
          h += '<a class="alt ' + p.c + '" href="' + l.url + '" target="_blank" rel="noopener noreferrer">' + esc(p.n) + '</a>';
        });
      }
      h += '</div>';
    });
    h += '</div>';

    h += '<div class="sl"><span>预览</span></div>';
    var hi = mod.previewImages && mod.previewImages.length > 0, hv = mod.previewVideos && mod.previewVideos.length > 0;
    if (hi && hv) {
      h += '<div class="ps"><button class="pt act" id="pIT" onclick="window._sP(\'images\')">' + imS + ' 预览图片<span class="pc">(' + mod.previewImages.length + ')</span></button><button class="pt" id="pVT" onclick="window._sP(\'videos\')">' + viS + ' 预览视频<span class="pc">(' + mod.previewVideos.length + ')</span></button></div><div id="pA"><div class="pp">' + rPI(mod.previewImages) + '</div></div>';
    } else if (hi) {
      h += '<div class="psg">' + imS + ' 预览图片<span class="psgc">(' + mod.previewImages.length + ')</span></div><div class="pp">' + rPI(mod.previewImages) + '</div>';
    } else if (hv) {
      h += '<div class="psg">' + viS + ' 预览视频<span class="psgc">(' + mod.previewVideos.length + ')</span></div><div class="pp">' + rPV(mod.previewVideos) + '</div>';
    } else {
      h += '<div class="pe">该MOD暂无预览资源</div>';
    }

    mC.innerHTML = h;
    mO.classList.add('act');
    document.body.style.overflow = 'hidden';
    mO.scrollTop = 0;

    var dTe = document.getElementById('dT'), dO = document.getElementById('dO');
    if (dTe && dO) {
      cOF(dTe, dO);
      dO.addEventListener('click', function () {
        var e = dTe.classList.toggle('exp');
        dO.textContent = e ? '收起' : '展开全文';
      });
    }
    setTimeout(function () {
      document.querySelectorAll('.id').forEach(function (el) {
        var tg = el.nextElementSibling;
        if (tg && tg.classList.contains('idt')) cOF(el, tg);
      });
    }, 100);

    window._cm = mod;
    window._ap = hi && hv ? 'images' : null;

    if (isEditMode) {
      makeModalEditable(mod);
    }
  }

  function cM() {
    if (isEditMode) {
      saveEditData();
      mC.querySelectorAll('.mra').forEach(function (el) { el.style.pointerEvents = ''; el.style.opacity = ''; });
    }
    mO.classList.remove('act');
    document.body.style.overflow = '';
    currentMod = null;
    activePreviewTab = null;
  }
  mX.addEventListener('click', cM);
  mO.addEventListener('click', function (e) { if (e.target === mO) cM(); });

  // ===== 全局函数暴露（供内联事件调用） =====
  window._oLB = oLB;
  window._cPT = copyText;
  window._sTM = showToast;
  window._tS = function (el) {
    var b = el.nextElementSibling, a = el.querySelector('.sa2'), c = b.classList.contains('co');
    if (c) {
      b.classList.remove('co');
      b.style.maxHeight = b.scrollHeight + 'px';
      a.classList.add('op');
    } else {
      b.style.maxHeight = b.scrollHeight + 'px';
      requestAnimationFrame(function () {
        b.classList.add('co');
        a.classList.remove('op');
      });
    }
  };
  window._tID = function (el) {
    var tid = el.getAttribute('data-target'), de = document.getElementById(tid);
    if (!de) return;
    var e = de.classList.toggle('exp');
    el.textContent = e ? '收起' : '展开';
    var sb = de.closest('.sb');
    if (sb && !sb.classList.contains('co')) sb.style.maxHeight = sb.scrollHeight + 'px';
  };
  window._sP = function (tab) {
    var mod = window._cm;
    if (!mod) return;
    var a = document.getElementById('pA');
    if (!a) return;
    var it = document.getElementById('pIT'), vt = document.getElementById('pVT');
    if (window._ap === tab) return;
    window._ap = tab;
    if (it) it.classList.toggle('act', tab === 'images');
    if (vt) vt.classList.toggle('act', tab === 'videos');
    a.innerHTML = '<div class="pp">' + (tab === 'images' ? rPI(mod.previewImages) : rPV(mod.previewVideos)) + '</div>';
  };

  // ===== 搜索功能（保留原站逻辑） =====
  async function performGlobalRidSearch(rid) {
    var categories = ['all', 'skin'];

    for (var i = 0; i < categories.length; i++) {
      var cat = categories[i];
      if (allSiteData[cat]) {
        var found = allSiteData[cat].find(function (m) { return m.id === rid; });
        if (found) return found;
      }
    }

    for (var j = 0; j < categories.length; j++) {
      var cat2 = categories[j];
      if (!allSiteData[cat2]) {
        await loadAllDataForCategory(cat2);
      }
      if (allSiteData[cat2]) {
        var found2 = allSiteData[cat2].find(function (m) { return m.id === rid; });
        if (found2) return found2;
      }
    }

    return null;
  }

  function filterMods() {
    var filtered = baseModData.slice();
    var query = sI.value.trim();

    if (query) {
      var lowerQuery = query.toLowerCase();

      if (lowerQuery.startsWith('rid:')) {
        var ridPart = lowerQuery.slice(4).trim();
        performGlobalRidSearch(ridPart).then(function (found) {
          if (found) {
            oM(found);
            sI.value = '';
            searchDropdown.classList.remove('active');
          } else {
            mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--tm)">未找到该 RID</div>';
            paginationEl.innerHTML = '';
          }
        });
        return;
      } else if (/^\d+$/.test(query)) {
        performGlobalRidSearch(query).then(function (found) {
          if (found) {
            oM(found);
            sI.value = '';
            searchDropdown.classList.remove('active');
          } else {
            mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--tm)">未找到该 RID</div>';
            paginationEl.innerHTML = '';
          }
        });
        return;
      } else {
        filtered = filtered.filter(function (m) {
          if (m.title.toLowerCase().includes(lowerQuery)) return true;
          if (m.tags && m.tags.some(function (tag) { return tag.toLowerCase().includes(lowerQuery); })) return true;
          return false;
        });
      }
    }

    currentPage = 1;
    modData = filtered;
    preloadState.currentPreloadPage = 0;
    renderPage(1);
    updateSearchDropdown(query);
  }

  function updateSearchDropdown(query) {
    searchDropdown.innerHTML = '';
    if (!query || query.length < 1) {
      searchDropdown.classList.remove('active');
      return;
    }

    var lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('rid:') || /^\d+$/.test(query)) {
      searchDropdown.classList.remove('active');
      return;
    }

    var matches = modData.filter(function (m) {
      if (m.title.toLowerCase().includes(lowerQuery)) return true;
      if (m.tags && m.tags.some(function (tag) { return tag.toLowerCase().includes(lowerQuery); })) return true;
      return false;
    });

    if (matches.length === 0) {
      searchDropdown.innerHTML = '<li style="padding:16px;text-align:center;color:var(--tm)">没有找到相关MOD</li>';
    } else {
      var escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var regex = new RegExp('(' + escapedQuery + ')', 'gi');
      matches.slice(0, 8).forEach(function (m) {
        var li = document.createElement('li');
        li.className = 'search-dropdown-item';
        li.innerHTML = m.title.replace(regex, '<mark>$1</mark>');
        li.addEventListener('click', function () {
          sI.value = m.title;
          searchDropdown.classList.remove('active');
          filterMods();
        });
        searchDropdown.appendChild(li);
      });
    }

    searchDropdown.classList.add('active');
  }

  // ===== 分类切换 =====
  async function loadModData(categoryKey) {
    categoryKey = categoryKey || 'all';
    if (isEditMode) saveEditData();
    selectedMods.clear();
    currentPage = 1;
    preloadState.currentPreloadPage = 0;
    var loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;

    if (allSiteData[categoryKey]) {
      modData = allSiteData[categoryKey];
      baseModData = modData;
      sI.value = '';
      searchDropdown.classList.remove('active');
      renderPage(1);
      return;
    }

    mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;"><img src="' + loaded2Src + '" alt="加载中" style="max-width:200px;"></div>';
    paginationEl.innerHTML = '';

    var data = await loadAllDataForCategory(categoryKey);
    if (data && data.length) {
      modData = data;
      baseModData = data;
      sI.value = '';
      searchDropdown.classList.remove('active');
      renderPage(1);
    } else {
      mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;">MOD数据加载失败，请稍后再试</div>';
    }
  }

  document.getElementById('categoryTabs').addEventListener('click', function (e) {
    var tab = e.target.closest('.category-tab');
    if (!tab) return;
    document.querySelectorAll('.category-tab').forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');
    activeCategory = tab.getAttribute('data-category') || 'all';
    loadModData(activeCategory);
  });

  // ===== 搜索事件 =====
  sI.addEventListener('input', filterMods);
  sI.addEventListener('focus', function () {
    if (sI.value.trim().length >= 1) updateSearchDropdown(sI.value.trim());
  });
  sI.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      searchDropdown.classList.remove('active');
      sI.blur();
    }
    if (e.key === 'Enter') {
      searchDropdown.classList.remove('active');
      filterMods();
    }
  });

  document.addEventListener('click', function (e) {
    if (!searchContainer.contains(e.target)) searchDropdown.classList.remove('active');
  });

  // ===== 窗口大小调整 =====
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (modData.length > 0) {
        renderPagination(modData.length, currentPage);
      }
    }, 200);
  });

  // ===== 菜单 toggle =====
  if (menuBtn && menuPanel) {
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      menuPanel.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (menuPanel.classList.contains('open') && !menuPanel.contains(e.target) && e.target !== menuBtn) {
        menuPanel.classList.remove('open');
      }
    });
  }

  // ===== 暗黑模式 =====
  var DARK_KEY = 'sts2_dark_mode';
  function applyTheme(isDark) {
    if (isDark) {
      document.documentElement.classList.add('dark');
      if (themeIconSun) themeIconSun.style.display = 'none';
      if (themeIconMoon) themeIconMoon.style.display = 'block';
    } else {
      document.documentElement.classList.remove('dark');
      if (themeIconSun) themeIconSun.style.display = 'block';
      if (themeIconMoon) themeIconMoon.style.display = 'none';
    }
  }
  var savedDark = localStorage.getItem(DARK_KEY) === '1';
  applyTheme(savedDark);

  if (themeToggle) {
    themeToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem(DARK_KEY, isDark ? '1' : '0');
      applyTheme(isDark);
      if (menuPanel) menuPanel.classList.remove('open');
    });
  }

  // ===== URL参数处理（RID跳转） =====
  async function handleUrlParams() {
    var params = new URLSearchParams(window.location.search);
    var rid = params.get('rid');
    if (rid) {
      var found = await performGlobalRidSearch(rid);
      if (found) {
        oM(found);
      } else {
        showToast('未找到该帖子');
      }
      history.replaceState({}, document.title, window.location.pathname);
    }
  }

  // ===== 初始化 =====
  async function initPage() {
    var loadingGifUrls = [
      'http://shp.qpic.cn/collector/1976464052/8ca28b73-c355-4abe-92e8-d4da82b9c560/0',
      'https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRQw4iaPl6ZCFxU66CiaGkhEicLCnEibnfSRX2T4Zhze15Rbg/0'
    ];
    var loaded2GifUrls = [
      'http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0',
      'https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRb8kvrUia3vonmc1Qke2xRzZticdf6bkIGYzicc43F7x6RI/0'
    ];

    try {
      var fetchWithTimeout = Promise.race([
        fetch('resources/json/config.json', { cache: 'no-store' }),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('timeout')); }, 3000);
        })
      ]);
      var resp = await fetchWithTimeout;
      if (resp.ok) {
        var config = await resp.json();
        if (config.loadingGifUrls && config.loadingGifUrls.length) loadingGifUrls = config.loadingGifUrls;
        if (config.loaded2GifUrls && config.loaded2GifUrls.length) loaded2GifUrls = config.loaded2GifUrls;
      }
    } catch (e) {}

    var gifPromise = raceImage(loadingGifUrls).catch(function () { return null; });
    gifPromise.then(function (src) {
      if (src) {
        loadingGif.src = src;
        loadingGif.style.display = 'block';
        if (potionWrapper) potionWrapper.style.display = 'none';
      }
    });

    var loaded2Promise = raceImage(loaded2GifUrls).catch(function () { return null; });
    loaded2Promise.then(function (src) {
      if (src) window.loaded2GifSrc = src;
    });

    var urlParams = new URLSearchParams(window.location.search);
    var hasRid = !!urlParams.get('rid');

    var preloadPromise = Promise.race([
      priorityPreload(),
      new Promise(function (resolve) { setTimeout(resolve, 6000); })
    ]);

    await preloadPromise;

    loadingOverlay.classList.add('hidden');
    mainContent.style.opacity = '1';

    if (allSiteData['all']) {
      modData = allSiteData['all'];
      baseModData = modData;
      renderPage(1);
    } else {
      loadModData('all');
    }

    if (hasRid) {
      handleUrlParams();
    }

    initEditMode();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }

  // ============================================
  // ===== 编辑模式系统（编辑器特有功能） =====
  // ============================================
  var isEditMode = false;
  var editFab, editToolbar, editSidebar;
  var EDIT_KEY = 'sts2_editor_data';
  var editData = { sts2_mods: null, 'O.o_interface': null };
  var selectedMods = new Set();
  var originalSiteData = {};

  function initEditMode() {
    editFab = document.createElement('button');
    editFab.className = 'edit-fab';
    editFab.innerHTML = '✎';
    editFab.title = '编辑模式 (Ctrl+Shift+E)';
    document.body.appendChild(editFab);

    editFab.addEventListener('click', toggleEditMode);

    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        toggleEditMode();
      }
    });

    loadEditData();
  }

  function toggleEditMode() {
    isEditMode = !isEditMode;
    editFab.classList.toggle('active', isEditMode);
    document.body.classList.toggle('edit-mode-active', isEditMode);

    if (isEditMode) {
      showEditToolbar();
      setTimeout(function() {
        updateToolbarPadding();
        if (editFab) editFab.style.bottom = (editToolbar ? editToolbar.offsetHeight + 24 : 80) + 'px';
      }, 50);
      window.addEventListener('resize', updateToolbarPadding);
      renderPage(currentPage);
      showToast('编辑模式已开启');
    } else {
      hideEditToolbar();
      hideEditSidebar();
      selectedMods.clear();
      document.body.style.paddingTop = '';
      if (editFab) editFab.style.bottom = '';
      window.removeEventListener('resize', updateToolbarPadding);
      if (mO && mO.classList.contains('act')) cM();
      renderPage(currentPage);
      showToast('已退出编辑模式');
    }
  }

  function showEditToolbar() {
    if (editToolbar) editToolbar.remove();

    editToolbar = document.createElement('div');
    editToolbar.className = 'edit-toolbar';
    editToolbar.innerHTML =
      '<span class="edit-toolbar-label">编辑模式</span>' +
      '<div class="edit-toolbar-actions">' +
      '<button class="et-btn et-btn--add" id="etAdd">+ 添加新MOD</button>' +
      '<button class="et-btn" id="etSelectAll">全选</button>' +
      '<button class="et-btn" id="etExport">导出选中（ZIP）</button>' +
      '<button class="et-btn" id="etExportAll">导出全部（ZIP）</button>' +
      '<span class="et-sep"></span>' +
      '<button class="et-btn" id="etImportJson">导入JSON</button>' +
      '<button class="et-btn" id="etImportZip">导入ZIP</button>' +
      '<button class="et-btn" id="etFileList">文件列表</button>' +
      '<span class="et-sep"></span>' +
      '<button class="et-btn et-btn--accent" id="etSave">保存到本地</button>' +
      '<button class="et-btn" id="etRestore">从本地还原</button>' +
      '<button class="et-btn et-btn--warn" id="etReset">重置编辑</button>' +
      '<button class="et-btn et-btn--collapse" id="etCollapse">收起</button>' +
      '<button class="et-btn et-btn--exit" id="etExit">退出编辑</button>' +
      '</div>';

    document.body.appendChild(editToolbar);

    document.getElementById('etAdd').addEventListener('click', addNewMod);
    document.getElementById('etSelectAll').addEventListener('click', toggleSelectAll);
    document.getElementById('etExport').addEventListener('click', exportSelectedZip);
    document.getElementById('etExportAll').addEventListener('click', exportAllZip);
    document.getElementById('etImportJson').addEventListener('click', importJson);
    document.getElementById('etImportZip').addEventListener('click', importZip);
    document.getElementById('etFileList').addEventListener('click', toggleEditSidebar);
    document.getElementById('etSave').addEventListener('click', saveEditData);
    document.getElementById('etRestore').addEventListener('click', restoreEditData);
    document.getElementById('etReset').addEventListener('click', resetEdit);
    document.getElementById('etCollapse').addEventListener('click', collapseAllSections);
    document.getElementById('etExit').addEventListener('click', toggleEditMode);
  }

  function hideEditToolbar() {
    if (editToolbar) {
      editToolbar.remove();
      editToolbar = null;
    }
  }

  // ===== 文件列表侧边栏 =====
  function toggleEditSidebar() {
    if (editSidebar && editSidebar.classList.contains('edit-sidebar-open')) {
      hideEditSidebar();
    } else {
      showEditSidebar();
    }
  }

  var _sidebarHiding = false;
  function showEditSidebar() {
    if (_sidebarHiding) return;
    if (editSidebar) editSidebar.remove();

    var overlay = document.createElement('div');
    overlay.className = 'edit-sidebar-overlay';
    overlay.id = 'editSidebarOverlay';
    overlay.addEventListener('click', hideEditSidebar);
    document.body.appendChild(overlay);
    setTimeout(function () { overlay.classList.add('active'); }, 10);

    editSidebar = document.createElement('div');
    editSidebar.className = 'edit-sidebar';
    editSidebar.id = 'editSidebar';
    editSidebar.innerHTML =
      '<div class="edit-sidebar-header">' +
      '<span class="edit-sidebar-title">文件列表</span>' +
      '<button class="edit-sidebar-close" id="esClose">×</button>' +
      '</div>' +
      '<div class="edit-sidebar-list" id="esList"></div>';

    document.body.appendChild(editSidebar);
    document.getElementById('esClose').addEventListener('click', hideEditSidebar);

    renderSidebarList();

    setTimeout(function () {
      editSidebar.classList.add('edit-sidebar-open');
    }, 10);
  }

  function hideEditSidebar() {
    if (editSidebar) {
      _sidebarHiding = true;
      editSidebar.classList.remove('edit-sidebar-open');
      var overlay = document.getElementById('editSidebarOverlay');
      if (overlay) overlay.classList.remove('active');
      setTimeout(function () {
        if (editSidebar) { editSidebar.remove(); editSidebar = null; }
        if (overlay && overlay.parentElement) overlay.remove();
        _sidebarHiding = false;
      }, 350);
    }
  }

  function renderSidebarList() {
    var list = document.getElementById('esList');
    if (!list) return;
    list.innerHTML = '';

    var categories = [
      { key: 'all', label: '模组合集 (sts2_mods)', dir: 'sts2_mods' },
      { key: 'skin', label: '网盘资源 (O.o_interface)', dir: 'O.o_interface' }
    ];

    categories.forEach(function (cat) {
      var data = allSiteData[cat.key] || [];
      var div = document.createElement('div');
      div.className = 'edit-sidebar-category';
      div.textContent = cat.label;
      list.appendChild(div);

      var manifest = manifestCache[cat.key];
      var dir = cat.dir;
      var files = [];

      if (manifest && manifest[dir]) {
        var rangeStr = manifest[dir];
        var indices = parseManifestRange(rangeStr);
        indices.forEach(function (idx) {
          files.push({ name: dir + '_' + idx + '.json', index: idx });
        });
      } else {
        files.push({ name: dir + '_1.json', index: 1 });
      }

      files.forEach(function (file) {
        var item = document.createElement('div');
        item.className = 'edit-sidebar-item';

        var fileData = [];
        if (allSiteData[cat.key]) {
          var start = (file.index - 1) * ITEMS_PER_PAGE;
          var end = start + ITEMS_PER_PAGE;
          fileData = allSiteData[cat.key].slice(start, end);
        }

        item.innerHTML =
          '<span class="edit-sidebar-item-name">' + esc(file.name) + '</span>' +
          '<span class="edit-sidebar-item-count">' + fileData.length + ' 条</span>' +
          '<button class="edit-sidebar-item-export" data-cat="' + cat.key + '" data-idx="' + file.index + '">导出ZIP</button>';

        item.querySelector('.edit-sidebar-item-export').addEventListener('click', function () {
          exportFileZip(cat.key, file.index, file.name);
        });

        list.appendChild(item);
      });
    });
  }

  // ===== 列表页编辑增强 =====
  function attachEditControlsToCards() {
    document.querySelectorAll('.cd').forEach(function (card) {
      card.classList.add('edit-mode');
      var modId = card.dataset.modId;
      if (!modId) return;

      var cv = card.querySelector('.cv');
      if (!cv) return;

      if (!card.querySelector('.mod-card-edit-check')) {
        var check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'mod-card-edit-check';
        check.checked = selectedMods.has(modId);
        check.addEventListener('change', function () {
          if (this.checked) selectedMods.add(modId);
          else selectedMods.delete(modId);
        });
        cv.appendChild(check);
      }

      if (!card.querySelector('.mod-card-edit-delete')) {
        var delBtn = document.createElement('button');
        delBtn.className = 'mod-card-edit-delete';
        delBtn.innerHTML = '×';
        delBtn.title = '删除';
        delBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (confirm('确定要删除这个MOD吗？')) {
            deleteMod(modId);
          }
        });
        cv.appendChild(delBtn);
      }

      if (!card.querySelector('.mod-card-edit-cover-btn')) {
        var coverBtn = document.createElement('button');
        coverBtn.className = 'mod-card-edit-cover-btn';
        coverBtn.textContent = '换封面';
        coverBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          changeCover(modId);
        });
        cv.appendChild(coverBtn);
      }

      if (!card.querySelector('.mod-card-edit-badge-btn')) {
        var badgeBtn = document.createElement('button');
        badgeBtn.className = 'mod-card-edit-badge-btn';
        badgeBtn.textContent = '改版本';
        badgeBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          changeBadge(modId);
        });
        cv.appendChild(badgeBtn);
      }

      if (!card.querySelector('.mod-card-edit-detail-btn')) {
        var detailBtn = document.createElement('button');
        detailBtn.className = 'mod-card-edit-detail-btn';
        detailBtn.textContent = '查看详情';
        detailBtn.className = 'mod-card-edit-detail-btn';
        detailBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var mod = modData.find(function (m) { return m.id === modId; });
          if (mod) oM(mod);
        });
        cv.appendChild(detailBtn);
      }
    });

    // 使标题、大小、日期、版本号可编辑
    document.querySelectorAll('.cd').forEach(function (card) {
      var modId = card.dataset.modId;
      if (!modId) return;
      var mod = modData.find(function (m) { return m.id === modId; });
      if (!mod) return;

      var titleEl = card.querySelector('.tt');
      if (titleEl && !titleEl.isContentEditable) {
        titleEl.contentEditable = true;
        titleEl.classList.add('editable-field');
        titleEl.addEventListener('blur', function () {
          var text = this.textContent.trim().replace(/[<>"'&]/g, '').replace(/[\n\r]/g, ' ');
          if (!text) text = '未命名';
          mod.title = text;
          this.textContent = text;
          saveEditData();
        });
        titleEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
        });
      }

      var badgeEl = card.querySelector('.tv');
      if (badgeEl && !badgeEl.isContentEditable) {
        badgeEl.contentEditable = true;
        badgeEl.classList.add('editable-field');
        badgeEl.addEventListener('blur', function () {
          mod.badge = this.textContent.trim();
          saveEditData();
        });
      }

      var sizeDateEls = card.querySelectorAll('.mt span');
      sizeDateEls.forEach(function (el, idx) {
        if (el.classList.contains('md')) return;
        if (!el.isContentEditable) {
          el.contentEditable = true;
          el.classList.add('editable-field');
          el.setAttribute('data-field', idx === 0 ? 'size' : 'date');
          el.addEventListener('blur', function () {
            var text = this.textContent.trim().replace(/[\n\r]/g, ' ').replace(/[<>]/g, '');
            if (!text) return;
            var field = this.getAttribute('data-field');
            if (field === 'size') mod.size = text;
            else if (field === 'date') mod.date = text;
            saveEditData();
          });
          el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
          });
        }
      });
    });

    document.querySelectorAll('.mod-tag-add-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var modId = this.dataset.modId;
        addTag(modId);
      });
    });

    document.querySelectorAll('.tag-delete-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var tag = this.dataset.tag;
        var modId = this.closest('.cd').dataset.modId;
        if (confirm('确定删除标签 "' + tag + '" 吗？')) {
          removeTag(modId, tag);
        }
      });
    });
  }

  // ===== 详情页编辑增强 =====
  function makeModalEditable(mod) {
    var prevEditControls = mC.querySelectorAll('.inline-edit-wrap, .edit-desc-textarea');
    prevEditControls.forEach(function (el) { el.remove(); });
    mC.querySelectorAll('.edit-hidden').forEach(function (el) { el.classList.remove('edit-hidden'); });
    mC.querySelectorAll('.mra').forEach(function (el) { el.style.pointerEvents = 'none'; el.style.opacity = '0.4'; });
    var titleEl = mC.querySelector('.mit');
    if (titleEl) {
      titleEl.contentEditable = true;
      titleEl.classList.add('editable-field');
      titleEl.addEventListener('blur', function () {
        mod.title = this.textContent.trim();
        saveEditData();
        renderPage(currentPage);
      });
    }

    var badgeEls = mC.querySelectorAll('.mmi');
    badgeEls.forEach(function (el, idx) {
      if (idx >= 3) return;
      if (idx === 0) {
        el.contentEditable = true;
        el.classList.add('editable-field');
        el.addEventListener('blur', function () {
          var text = this.textContent.trim().replace(/[<>"'&]/g, '').replace(/[\n\r]/g, ' ');
          if (!text) text = 'v1.0';
          mod.badge = text;
          this.textContent = text;
          saveEditData();
          renderPage(currentPage);
        });
        el.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        });
      } else if (idx === 1) {
        el.contentEditable = true;
        el.classList.add('editable-field');
        el.addEventListener('blur', function () {
          var text = this.textContent.trim().replace(/[\n\r]/g, ' ').replace(/[<>]/g, '');
          if (text) { mod.size = text; this.textContent = text; }
          saveEditData();
          renderPage(currentPage);
        });
        el.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        });
      } else if (idx === 2) {
        el.contentEditable = true;
        el.classList.add('editable-field');
        el.addEventListener('blur', function () {
          var text = this.textContent.trim().replace(/[\n\r]/g, ' ').replace(/[<>]/g, '');
          if (text) { mod.date = text; this.textContent = text; }
          saveEditData();
          renderPage(currentPage);
        });
        el.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        });
      }
    });

    var ridWrap = mC.querySelector('.mrg-wrap');
    if (ridWrap) {
      var ridTextEl = ridWrap.querySelector('.mrt');
      if (ridTextEl) {
        ridTextEl.contentEditable = true;
        ridTextEl.classList.add('editable-field');
        ridTextEl.style.cssText = 'outline:none;cursor:text;padding:2px 6px;border-radius:4px;border:1px dashed transparent;transition:border-color .2s';
        ridTextEl.addEventListener('focus', function () {
          this.style.borderColor = 'var(--bd)';
        });
        ridTextEl.addEventListener('blur', function () {
          this.style.borderColor = 'transparent';
          var newId = this.textContent.replace(/^RID\s*/, '').trim();
          if (newId && newId !== mod.id) {
            mod.id = newId;
            saveEditData();
            renderPage(currentPage);
            showToast('RID已更新');
          }
        });
      }
      if (!ridWrap.querySelector('.modal-rid-regen-btn')) {
        var ridRegenBtn = document.createElement('button');
        ridRegenBtn.className = 'modal-rid-regen-btn';
        ridRegenBtn.innerHTML = '↻ 重新生成RID';
        ridRegenBtn.addEventListener('click', function () {
          if (confirm('确定要重新生成RID吗？')) {
            var oldId = mod.id;
            mod.id = generateRID();
            saveEditData();
            renderPage(currentPage);
            oM(mod);
            showToast('RID已重新生成');
          }
        });
        ridWrap.appendChild(ridRegenBtn);
      }
    }

    // 标签编辑
    var tagsWrap = mC.querySelector('.mts');
    if (tagsWrap) {
      var addTagBtn = document.createElement('button');
      addTagBtn.className = 'modal-edit-add-btn';
      addTagBtn.textContent = '+ 添加标签';
      addTagBtn.style.marginTop = '8px';
      addTagBtn.addEventListener('click', function () {
        addTag(mod.id);
      });
      tagsWrap.appendChild(addTagBtn);

      tagsWrap.querySelectorAll('.mtg').forEach(function (tagEl) {
        var delBtn = document.createElement('span');
        delBtn.textContent = ' ×';
        delBtn.style.cssText = 'cursor:pointer;color:#b14b4b;font-weight:700;margin-left:2px';
        delBtn.addEventListener('click', function () {
          var tag = tagEl.textContent.replace(' ×', '').trim();
          if (confirm('确定删除标签 "' + tag + '" 吗？')) {
            removeTag(mod.id, tag);
            oM(mod);
          }
        });
        tagEl.appendChild(delBtn);
      });
    }

    // 简介编辑（使用 textarea 保留换行）
    var descEl = document.getElementById('dT');
    if (descEl) {
      var descText = mod.description || '';
      var textarea = document.createElement('textarea');
      textarea.className = 'editable-field';
      textarea.style.cssText = 'width:100%;min-height:120px;padding:10px;font-size:.9rem;font-family:inherit;border:2px solid var(--bd);border-radius:10px;resize:vertical';
      textarea.value = descText;
      textarea.addEventListener('blur', function () {
        mod.description = this.value;
        saveEditData();
      });
      descEl.parentElement.insertBefore(textarea, descEl);
      descEl.style.display = 'none';
    }

    // 下载链接编辑
    makeDownloadLinksEditable(mod);

    // 作者栏编辑
    makeAuthorsEditable(mod);

    // 预览图片/视频URL编辑
    makePreviewsEditable(mod);
  }

  function makeDownloadLinksEditable(mod) {
    var dlSections = mC.querySelectorAll('.dsw');
    var slLabels = mC.querySelectorAll('.sl');
    dlSections.forEach(function (sec) { sec.style.display = 'none'; });
    slLabels.forEach(function (sl) {
      var t = sl.textContent.trim();
      if (t === '下载方式' || t === '更多') sl.style.display = 'none';
    });
    var cl = cLL(mod.downloadLinks || []);
    var editWrap = document.createElement('div');
    editWrap.className = 'inline-edit-wrap';
    editWrap.setAttribute('data-section', 'downloads');
    function stripCatPrefix(text, catKey) {
      var t = text || '';
      if (catKey === 'alternative') {
        t = t.replace(/^(其他下载方式?\s*[-—]?\s*|alternative\s*[-—]?\s*)/i, '');
      } else if (catKey === 'history') {
        t = t.replace(/^(历史版本\s*[-—]?\s*|history\s*[-—]?\s*)/i, '');
      }
      return t;
    }
    function addCatPrefix(text, catKey) {
      if (catKey === 'alternative') {
        return '其他下载 - ' + text;
      } else if (catKey === 'history') {
        return '历史版本 - ' + text;
      }
      return text;
    }
    var categories = [
      { key: 'latest', label: '最新版本', items: cl.latest.map(function (dl) {
        return { text: stripCatPrefix(dl.text, 'latest'), url: dl.url || '', version: dl.version || '', size: dl.size || '', date: dl.date || '', desc: dl.desc || '' };
      })},
      { key: 'alternative', label: '其他下载方式', items: cl.alternative.map(function (dl) {
        return { text: stripCatPrefix(dl.text, 'alternative'), url: dl.url || '', version: dl.version || '', size: dl.size || '', date: dl.date || '', desc: dl.desc || '' };
      })},
      { key: 'history', label: '历史版本', items: cl.history.map(function (dl) {
        return { text: stripCatPrefix(dl.text, 'history'), url: dl.url || '', version: dl.version || '', size: dl.size || '', date: dl.date || '', desc: dl.desc || '' };
      })}
    ];
    function renderCategory(cat, container) {
      container.innerHTML = '';
      var catTitle = document.createElement('div');
      catTitle.className = 'inline-edit-cat-title';
      catTitle.textContent = cat.label;
      container.appendChild(catTitle);
      cat.items.forEach(function (dl, idx) {
        var card = document.createElement('div');
        card.className = 'inline-edit-card';
        var titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.className = 'inline-edit-input';
        titleInput.placeholder = '标题';
        titleInput.value = dl.text || '';
        var urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'inline-edit-input';
        urlInput.placeholder = '下载链接';
        urlInput.value = dl.url || '';
        var metaRow = document.createElement('div');
        metaRow.className = 'inline-edit-meta-row';
        var verInput = document.createElement('input');
        verInput.type = 'text';
        verInput.className = 'inline-edit-input';
        verInput.placeholder = '版本号';
        verInput.value = dl.version || '';
        var sizeInput = document.createElement('input');
        sizeInput.type = 'text';
        sizeInput.className = 'inline-edit-input';
        sizeInput.placeholder = '大小';
        sizeInput.value = dl.size || '';
        var dateInput = document.createElement('input');
        dateInput.type = 'text';
        dateInput.className = 'inline-edit-input';
        dateInput.placeholder = '日期';
        dateInput.value = dl.date || '';
        metaRow.appendChild(verInput);
        metaRow.appendChild(sizeInput);
        metaRow.appendChild(dateInput);
        var descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.className = 'inline-edit-input';
        descInput.placeholder = '描述';
        descInput.value = dl.desc || '';
        metaRow.appendChild(descInput);
        card.appendChild(titleInput);
        card.appendChild(urlInput);
        card.appendChild(metaRow);
        var delBtn = document.createElement('button');
        delBtn.className = 'inline-edit-del-btn inline-edit-del-card-btn';
        delBtn.innerHTML = '删除此链接';
        delBtn.addEventListener('click', function () {
          cat.items.splice(idx, 1);
          renderCategory(cat, container);
        });
        card.appendChild(delBtn);
        container.appendChild(card);
      });
      var addBtn = document.createElement('button');
      addBtn.className = 'inline-edit-add-btn';
      addBtn.textContent = '+ 添加链接';
      addBtn.addEventListener('click', function () {
        cat.items.push({ text: '', url: '', version: '', size: '', date: '', desc: '' });
        renderCategory(cat, container);
      });
      container.appendChild(addBtn);
    }
    categories.forEach(function (cat) {
      var catWrap = document.createElement('div');
      catWrap.className = 'inline-edit-cat-wrap';
      catWrap.setAttribute('data-cat', cat.key);
      renderCategory(cat, catWrap);
      editWrap.appendChild(catWrap);
    });
    var saveBtn = document.createElement('button');
    saveBtn.className = 'inline-edit-save-btn';
    saveBtn.textContent = '保存下载方式';
    saveBtn.addEventListener('click', function () {
      var newLinks = [];
      categories.forEach(function (cat) {
        var catWrap = editWrap.querySelector('[data-cat="' + cat.key + '"]');
        var cards = catWrap.querySelectorAll('.inline-edit-card');
        cards.forEach(function (c) {
          var inputs = c.querySelectorAll(':scope > .inline-edit-input');
          var metaInputs = c.querySelectorAll('.inline-edit-meta-row .inline-edit-input');
          var text = (inputs[0] ? inputs[0].value : '').trim();
          var url = (inputs[1] ? inputs[1].value : '').trim();
          if (!text && !url) return;
          var finalText = addCatPrefix(text, cat.key);
          var link = { text: finalText, url: url };
          if (metaInputs.length >= 3) {
            var ver = metaInputs[0].value.trim();
            var sz = metaInputs[1].value.trim();
            var dt = metaInputs[2].value.trim();
            var dsc = metaInputs[3] ? metaInputs[3].value.trim() : '';
            if (ver) link.version = ver;
            if (sz) link.size = sz;
            if (dt) link.date = dt;
            if (dsc) link.desc = dsc;
          }
          newLinks.push(link);
        });
      });
      mod.downloadLinks = newLinks;
      var latestCat = categories.find(function (c) { return c.key === 'latest'; });
      if (latestCat && latestCat.items.length > 0) {
        var first = latestCat.items[0];
        if (first.version && !mod.badge) mod.badge = first.version;
        if (first.size && (!mod.size || mod.size === '未知')) mod.size = first.size;
        if (first.date && !mod.date) mod.date = first.date;
      }
      saveEditData();
      oM(mod);
      showToast('下载方式已保存');
    });
    editWrap.appendChild(saveBtn);
    var firstDsw = mC.querySelector('.dsw');
    if (firstDsw) {
      firstDsw.parentElement.insertBefore(editWrap, firstDsw);
    } else {
      mC.appendChild(editWrap);
    }
  }

  function makeAuthorsEditable(mod) {
    var authorSection = mC.querySelector('.as');
    if (!authorSection) return;
    authorSection.style.display = 'none';
    var slLabels = mC.querySelectorAll('.sl');
    slLabels.forEach(function (sl) {
      if (sl.textContent.trim() === '作者') sl.classList.add('edit-hidden');
    });
    var parsed = mLA(pA(mod.author || ''), mod.authorLinks || []);
    var editWrap = document.createElement('div');
    editWrap.className = 'inline-edit-wrap';
    editWrap.setAttribute('data-section', 'authors');
    function renderCards() {
      editWrap.innerHTML = '';
      parsed.forEach(function (a, idx) {
        var card = document.createElement('div');
        card.className = 'inline-edit-card';
        var roleInput = document.createElement('input');
        roleInput.type = 'text';
        roleInput.className = 'inline-edit-input';
        roleInput.placeholder = '岗位/别名（可选）';
        roleInput.value = a.role || '';
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'inline-edit-input';
        nameInput.placeholder = '作者名（必填）';
        nameInput.value = a.name || '';
        card.appendChild(roleInput);
        card.appendChild(nameInput);
        var linksWrap = document.createElement('div');
        linksWrap.className = 'inline-edit-links-wrap';
        linksWrap.setAttribute('data-author-idx', idx);
        if (!a.links) a.links = [];
        a.links.forEach(function (l, li) {
          var linkRow = document.createElement('div');
          linkRow.className = 'inline-edit-link-row';
          var ltInput = document.createElement('input');
          ltInput.type = 'text';
          ltInput.className = 'inline-edit-input inline-edit-input-sm';
          ltInput.placeholder = '平台名称';
          ltInput.value = l.text || '';
          var luInput = document.createElement('input');
          luInput.type = 'text';
          luInput.className = 'inline-edit-input';
          luInput.placeholder = '平台链接';
          luInput.value = l.url || '';
          var delLinkBtn = document.createElement('button');
          delLinkBtn.className = 'inline-edit-del-btn';
          delLinkBtn.innerHTML = '×';
          delLinkBtn.title = '删除此链接';
          delLinkBtn.addEventListener('click', function () {
            a.links.splice(li, 1);
            renderCards();
          });
          linkRow.appendChild(ltInput);
          linkRow.appendChild(luInput);
          linkRow.appendChild(delLinkBtn);
          linksWrap.appendChild(linkRow);
        });
        var addLinkBtn = document.createElement('button');
        addLinkBtn.className = 'inline-edit-add-link-btn';
        addLinkBtn.textContent = '+ 添加平台链接';
        addLinkBtn.addEventListener('click', function () {
          if (!a.links) a.links = [];
          a.links.push({ text: '', url: '' });
          renderCards();
        });
        linksWrap.appendChild(addLinkBtn);
        card.appendChild(linksWrap);
        var delBtn = document.createElement('button');
        delBtn.className = 'inline-edit-del-btn inline-edit-del-card-btn';
        delBtn.innerHTML = '删除此作者';
        delBtn.addEventListener('click', function () {
          parsed.splice(idx, 1);
          renderCards();
        });
        card.appendChild(delBtn);
        editWrap.appendChild(card);
      });
      var addBtn = document.createElement('button');
      addBtn.className = 'inline-edit-add-btn';
      addBtn.textContent = '+ 添加作者';
      addBtn.addEventListener('click', function () {
        parsed.push({ role: '', name: '', links: [] });
        renderCards();
      });
      editWrap.appendChild(addBtn);
      var saveBtn = document.createElement('button');
      saveBtn.className = 'inline-edit-save-btn';
      saveBtn.textContent = '保存作者';
      saveBtn.addEventListener('click', function () {
        var cards = editWrap.querySelectorAll('.inline-edit-card');
        var newAuthors = [];
        cards.forEach(function (c, ci) {
          var inputs = c.querySelectorAll(':scope > .inline-edit-input');
          var role = inputs[0].value.trim();
          var name = inputs[1].value.trim();
          if (!name) return;
          var links = [];
          var linkRows = c.querySelectorAll('.inline-edit-link-row');
          linkRows.forEach(function (lr) {
            var lt = lr.querySelector('.inline-edit-input-sm').value.trim();
            var lu = lr.querySelectorAll('.inline-edit-input')[1].value.trim();
            if (lt || lu) links.push({ text: lt, url: lu });
          });
          newAuthors.push({ role: role, name: name, links: links });
        });
        mod.author = newAuthors.map(function (a) {
          if (a.role) return '[' + a.role + '] - ' + a.name;
          return a.name;
        }).join(' ');
        mod.authorLinks = [];
        newAuthors.forEach(function (a) {
          if (a.links && a.links.length) {
            a.links.forEach(function (l) {
              mod.authorLinks.push({ text: l.text + '|' + a.name.replace(/\|/g, '_'), url: l.url });
            });
          }
        });
        saveEditData();
        oM(mod);
        showToast('作者信息已保存');
      });
      editWrap.appendChild(saveBtn);
    }
    renderCards();
    authorSection.parentElement.insertBefore(editWrap, authorSection.nextSibling);
  }

  function makePreviewsEditable(mod) {
    var psgElements = mC.querySelectorAll('.psg');
    var ppElements = mC.querySelectorAll('.pp');
    var peElements = mC.querySelectorAll('.pe');
    var psgBtns = mC.querySelectorAll('.psb');
    var psElements = mC.querySelectorAll('.ps');
    var pAEl = document.getElementById('pA');
    psgElements.forEach(function (el) { el.classList.add('edit-hidden'); });
    ppElements.forEach(function (el) { el.classList.add('edit-hidden'); });
    peElements.forEach(function (el) { el.classList.add('edit-hidden'); });
    psgBtns.forEach(function (el) { el.classList.add('edit-hidden'); });
    psElements.forEach(function (el) { el.classList.add('edit-hidden'); });
    if (pAEl) pAEl.classList.add('edit-hidden');
    var slLabels = mC.querySelectorAll('.sl');
    slLabels.forEach(function (sl) {
      if (sl.textContent.trim() === '预览') sl.classList.add('edit-hidden');
    });
    var editWrap = document.createElement('div');
    editWrap.className = 'inline-edit-wrap';
    editWrap.setAttribute('data-section', 'previews');
    var images = (mod.previewImages || []).slice();
    var videos = (mod.previewVideos || []).slice();
    function renderImageInputs() {
      var imgContainer = editWrap.querySelector('[data-preview-type="images"]');
      if (!imgContainer) return;
      imgContainer.innerHTML = '';
      var imgTitle = document.createElement('div');
      imgTitle.className = 'inline-edit-cat-title';
      imgTitle.textContent = '预览图片';
      imgContainer.appendChild(imgTitle);
      images.forEach(function (url, idx) {
        var row = document.createElement('div');
        row.className = 'inline-edit-input-row';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.placeholder = '图片URL';
        input.value = url || '';
        var delBtn = document.createElement('button');
        delBtn.className = 'inline-edit-del-btn';
        delBtn.innerHTML = '×';
        delBtn.title = '删除此图片';
        delBtn.addEventListener('click', function () {
          images.splice(idx, 1);
          renderImageInputs();
        });
        row.appendChild(input);
        row.appendChild(delBtn);
        imgContainer.appendChild(row);
      });
      var addBtn = document.createElement('button');
      addBtn.className = 'inline-edit-add-btn';
      addBtn.textContent = '+ 添加图片URL';
      addBtn.addEventListener('click', function () {
        images.push('');
        renderImageInputs();
      });
      imgContainer.appendChild(addBtn);
    }
    function renderVideoInputs() {
      var vidContainer = editWrap.querySelector('[data-preview-type="videos"]');
      if (!vidContainer) return;
      vidContainer.innerHTML = '';
      var vidTitle = document.createElement('div');
      vidTitle.className = 'inline-edit-cat-title';
      vidTitle.textContent = '预览视频';
      vidContainer.appendChild(vidTitle);
      videos.forEach(function (url, idx) {
        var row = document.createElement('div');
        row.className = 'inline-edit-input-row';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.placeholder = '视频URL';
        input.value = url || '';
        var delBtn = document.createElement('button');
        delBtn.className = 'inline-edit-del-btn';
        delBtn.innerHTML = '×';
        delBtn.title = '删除此视频';
        delBtn.addEventListener('click', function () {
          videos.splice(idx, 1);
          renderVideoInputs();
        });
        row.appendChild(input);
        row.appendChild(delBtn);
        vidContainer.appendChild(row);
      });
      var addBtn = document.createElement('button');
      addBtn.className = 'inline-edit-add-btn';
      addBtn.textContent = '+ 添加视频URL';
      addBtn.addEventListener('click', function () {
        videos.push('');
        renderVideoInputs();
      });
      vidContainer.appendChild(addBtn);
    }
    var imgContainer = document.createElement('div');
    imgContainer.setAttribute('data-preview-type', 'images');
    imgContainer.className = 'inline-edit-preview-section';
    editWrap.appendChild(imgContainer);
    var vidContainer = document.createElement('div');
    vidContainer.setAttribute('data-preview-type', 'videos');
    vidContainer.className = 'inline-edit-preview-section';
    editWrap.appendChild(vidContainer);
    renderImageInputs();
    renderVideoInputs();
    var saveBtn = document.createElement('button');
    saveBtn.className = 'inline-edit-save-btn';
    saveBtn.textContent = '保存预览';
    saveBtn.addEventListener('click', function () {
      var imgInputs = editWrap.querySelectorAll('[data-preview-type="images"] .inline-edit-input');
      var newImages = [];
      imgInputs.forEach(function (inp) {
        var v = inp.value.trim();
        if (v) newImages.push(v);
      });
      var vidInputs = editWrap.querySelectorAll('[data-preview-type="videos"] .inline-edit-input');
      var newVideos = [];
      vidInputs.forEach(function (inp) {
        var v = inp.value.trim();
        if (v) newVideos.push(v);
      });
      var origIsNested = Array.isArray(mod.previewImages) && mod.previewImages.length > 0 && Array.isArray(mod.previewImages[0]);
      mod.previewImages = origIsNested ? newImages.map(function (u) { return [u]; }) : newImages;
      mod.previewVideos = newVideos;
      saveEditData();
      oM(mod);
      showToast('预览已保存');
    });
    editWrap.appendChild(saveBtn);
    var previewParent = pAEl || ppElements[0] || psgElements[0] || mC.querySelector('.psg');
    if (previewParent) {
      previewParent.parentElement.insertBefore(editWrap, previewParent);
    } else {
      mC.appendChild(editWrap);
    }
  }

  // ===== 全选 / 取消全选 =====
  function toggleSelectAll() {
    var btn = document.getElementById('etSelectAll');
    if (!btn) return;

    var pageData = getPageSlice(modData, currentPage);
    var allSelected = pageData.every(function (m) { return selectedMods.has(m.id); });

    if (allSelected) {
      modData.forEach(function (m) { selectedMods.delete(m.id); });
      btn.textContent = '全选';
      showToast('已取消全选');
    } else {
      modData.forEach(function (m) { selectedMods.add(m.id); });
      btn.textContent = '取消全选';
      showToast('已全选所有' + modData.length + '个MOD');
    }
    renderPage(currentPage);
  }

  // ===== ZIP 导出功能 =====
  async function exportSelectedZip() {
    if (selectedMods.size === 0) {
      showToast('请先选择要导出的MOD');
      return;
    }
    var selected = modData.filter(function (m) { return selectedMods.has(m.id); });
    await exportToZip(selected, 'selected_mods.zip');
  }

  async function exportAllZip() {
    await exportToZip(modData, 'all_mods.zip');
  }

  async function exportFileZip(categoryKey, fileIndex, fileName) {
    var data = [];
    if (allSiteData[categoryKey]) {
      var start = (fileIndex - 1) * ITEMS_PER_PAGE;
      var end = start + ITEMS_PER_PAGE;
      data = allSiteData[categoryKey].slice(start, end);
    }
    await exportToZip(data, fileName.replace('.json', '.zip'));
  }

  async function exportToZip(data, fileName) {
    if (typeof JSZip === 'undefined') {
      showToast('JSZip库未加载，请检查网络或刷新页面后重试');
      return;
    }
    try {
      var zip = new JSZip();
      var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
      var dir = dirMap[activeCategory] || 'sts2_mods';
      zip.file(dir + '/' + dir + '_1.json', JSON.stringify(data, null, 2));
      var blob = await zip.generateAsync({ type: 'blob' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      showToast('已导出：' + fileName);
    } catch (err) {
      showToast('导出失败：' + err.message);
    }
  }

  // ===== 导入功能 =====
  function importJson() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (event) {
        try {
          var imported = JSON.parse(event.target.result);
          if (Array.isArray(imported)) {
            mergeData(imported);
          } else if (imported.sts2_mods || imported['O.o_interface']) {
            if (imported.sts2_mods) mergeData(imported.sts2_mods);
            if (imported['O.o_interface']) mergeData(imported['O.o_interface']);
          } else {
            var keys = Object.keys(imported);
            var merged = false;
            keys.forEach(function (k) {
              if (Array.isArray(imported[k])) { mergeData(imported[k]); merged = true; }
            });
            if (!merged) showToast('无法识别的数据格式，支持：MOD数组、{sts2_mods:[...]}、{O.o_interface:[...]}');
          }
        } catch (err) {
          showToast('导入失败：' + err.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function importZip() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      if (typeof JSZip === 'undefined') {
        showToast('JSZip库未加载，请检查网络或刷新页面后重试');
        return;
      }
      var reader = new FileReader();
      reader.onload = function (event) {
        try {
          JSZip.loadAsync(event.target.result).then(function (zip) {
            var promises = [];
            zip.forEach(function (relativePath, zipEntry) {
              if (zipEntry.name.endsWith('.json')) {
                promises.push(zipEntry.async('string').then(function (content) {
                  return JSON.parse(content);
                }));
              }
            });
            return Promise.all(promises);
          }).then(function (arrays) {
            arrays.forEach(function (arr) {
              if (Array.isArray(arr)) mergeData(arr);
            });
          }).catch(function (err) {
            showToast('导入失败：' + err.message);
          });
        } catch (err) {
          showToast('导入失败：' + err.message);
        }
      };
      reader.readAsArrayBuffer(file);
    });
    input.click();
  }

  function mergeData(newData) {
    if (!Array.isArray(newData)) {
      showToast('数据格式错误');
      return;
    }

    var existingIds = new Set(modData.map(function (m) { return m.id; }));
    var added = 0;
    newData.forEach(function (item) {
      if (item.id && !existingIds.has(item.id)) {
        modData.push(item);
        added++;
      }
    });

    modData = sortModsByTimeId(modData);
    baseModData = modData;
    allSiteData[activeCategory] = modData;
    saveEditData();
    renderPage(1);

    triggerPostImportPreload();
    showToast('已导入 ' + added + ' 个MOD');
  }

  function triggerPostImportPreload() {
    setTimeout(function () {
      var page1Data = getPageSlice(modData, 1);
      var page2Data = getPageSlice(modData, 2);
      var page3Data = getPageSlice(modData, 3);
      var covers = extractCoverUrls(page1Data).concat(extractCoverUrls(page2Data)).concat(extractCoverUrls(page3Data));
      preloadImagesWithConcurrency(covers, 6);
      var previewUrls = [];
      [page1Data, page2Data].forEach(function (pd) {
        pd.forEach(function (mod) {
          if (mod.previewImages && mod.previewImages.length) {
            mod.previewImages.forEach(function (img) {
              var url = Array.isArray(img) ? img[0] : img;
              if (url && typeof url === 'string') previewUrls.push(url);
            });
          }
        });
      });
      if (previewUrls.length > 0) {
        setTimeout(function () { preloadImagesWithConcurrency(previewUrls.slice(0, 20), 3); }, 500);
      }
    }, 100);
  }

  // ===== 数据管理 =====
  function saveEditData() {
    var key = activeCategory === 'all' ? 'sts2_mods' : 'O.o_interface';
    editData[key] = modData;
    try {
      var jsonStr = JSON.stringify(editData);
      if (jsonStr.length > 4.5 * 1024 * 1024) {
        showToast('数据量过大（超过4.5MB），可能无法完整保存');
      }
      localStorage.setItem(EDIT_KEY, jsonStr);
      showToast('已保存到本地');
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.code === 22) {
        showToast('本地存储空间不足，数据未保存！请导出备份后清理');
      } else {
        showToast('保存失败：' + e.message);
      }
    }
  }

  function loadEditData() {
    try {
      var saved = localStorage.getItem(EDIT_KEY);
      if (saved) {
        editData = JSON.parse(saved);
        var key = activeCategory === 'all' ? 'sts2_mods' : 'O.o_interface';
        if (editData[key] && Array.isArray(editData[key]) && editData[key].length > 0) {
          modData = editData[key];
          baseModData = modData;
          allSiteData[activeCategory] = modData;
        }
      }
    } catch (e) {
      editData = { sts2_mods: null, 'O.o_interface': null };
    }
  }

  function restoreEditData() {
    try {
      var saved = localStorage.getItem(EDIT_KEY);
      if (!saved) {
        showToast('本地没有保存的数据');
        return;
      }
      var data = JSON.parse(saved);
      var key = activeCategory === 'all' ? 'sts2_mods' : 'O.o_interface';
      if (data[key] && Array.isArray(data[key])) {
        modData = data[key];
        baseModData = modData;
        allSiteData[activeCategory] = modData;
        renderPage(1);
        showToast('已从本地还原');
      } else {
        showToast('当前分类没有本地数据');
      }
    } catch (e) {
      showToast('还原失败：' + e.message);
    }
  }

  function resetEdit() {
    if (!confirm('确定要重置编辑吗？所有编辑数据将被清空，恢复原始JSON。')) return;

    var key = activeCategory === 'all' ? 'sts2_mods' : 'O.o_interface';
    var backupData = editData[key];
    editData[key] = null;
    localStorage.setItem(EDIT_KEY, JSON.stringify(editData));

    allSiteData[activeCategory] = null;
    delete manifestCache[activeCategory];
    loadModData(activeCategory).then(function () {
      showToast('已重置为原始数据');
    }).catch(function (err) {
      editData[key] = backupData;
      modData = backupData || modData;
      baseModData = modData;
      allSiteData[activeCategory] = modData;
      renderPage(1);
      showToast('重置失败，已恢复编辑数据：' + err.message);
    });
  }

  // ===== 基础编辑操作 =====
  function generateRID() {
    var now = new Date();
    var Y = now.getFullYear();
    var M = String(now.getMonth() + 1).padStart(2, '0');
    var D = String(now.getDate()).padStart(2, '0');
    var h = String(now.getHours()).padStart(2, '0');
    var m = String(now.getMinutes()).padStart(2, '0');
    var s = String(now.getSeconds()).padStart(2, '0');
    var ms = String(now.getMilliseconds()).padStart(3, '0');
    return String(Y) + M + D + h + m + s + ms;
  }

  function addNewMod() {
    var newMod = {
      id: generateRID(),
      title: '新MOD',
      badge: 'v1.0.0',
      size: '未知',
      date: new Date().toISOString().split('T')[0],
      tags: [],
      description: '',
      author: '',
      authorLinks: [],
      downloadLinks: [],
      previewImages: [],
      previewVideos: [],
      coverImage: '',
      coverGradient: 'linear-gradient(135deg,#f5f2f8,#ece7f3)'
    };

    modData.unshift(newMod);
    baseModData = modData;
    allSiteData[activeCategory] = modData;
    saveEditData();
    var totalPages = Math.ceil(modData.length / ITEMS_PER_PAGE);
    if (currentPage > totalPages) currentPage = totalPages;
    renderPage(currentPage);
    showToast('已添加新MOD');
  }

  function deleteMod(modId) {
    modData = modData.filter(function (m) { return m.id !== modId; });
    baseModData = modData;
    allSiteData[activeCategory] = modData;
    selectedMods.delete(modId);
    saveEditData();
    var totalPages = Math.ceil(modData.length / ITEMS_PER_PAGE);
    if (totalPages === 0) totalPages = 1;
    if (currentPage > totalPages) currentPage = totalPages;
    renderPage(currentPage);
    showToast('已删除');
  }

  function showEditInputDialog(title, placeholder, currentValue, callback) {
    var overlay = document.createElement('div');
    overlay.className = 'edit-dialog-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'edit-dialog';
    dialog.innerHTML = '<div class="edit-dialog-title">' + title + '</div>' +
      '<input type="text" class="edit-dialog-input" placeholder="' + placeholder + '" value="' + (currentValue || '').replace(/"/g, '&quot;') + '">' +
      '<div class="edit-dialog-preview"></div>' +
      '<div class="edit-dialog-actions"><button class="edit-dialog-cancel">取消</button><button class="edit-dialog-confirm">确定</button></div>';
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    var input = dialog.querySelector('.edit-dialog-input');
    var preview = dialog.querySelector('.edit-dialog-preview');
    input.focus();
    input.select();
    input.addEventListener('input', function () {
      var val = input.value.trim();
      if (val) { preview.innerHTML = '<img src="' + val.replace(/"/g, '&quot;') + '" style="max-width:200px;max-height:120px;border-radius:6px;margin-top:8px;" onerror="this.style.display=\'none\'" onload="this.style.display=\'block\'">'; }
      else { preview.innerHTML = ''; }
    });
    dialog.querySelector('.edit-dialog-cancel').addEventListener('click', function () { document.body.removeChild(overlay); });
    dialog.querySelector('.edit-dialog-confirm').addEventListener('click', function () { var val = input.value.trim(); document.body.removeChild(overlay); callback(val); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var val = input.value.trim(); document.body.removeChild(overlay); callback(val); }
      else if (e.key === 'Escape') { document.body.removeChild(overlay); }
    });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) document.body.removeChild(overlay); });
  }
  function changeCover(modId) {
    var mod = baseModData.find(function (m) { return m.id === modId; }) || modData.find(function (m) { return m.id === modId; });
    if (!mod) return;
    var currentUrl = '';
    if (mod.coverImage) {
      currentUrl = Array.isArray(mod.coverImage) ? mod.coverImage[0] || '' : mod.coverImage;
    }
    showEditInputDialog('更换封面', '请输入封面图片URL', currentUrl, function (url) {
      if (!url) return;
      mod.coverImage = url;
      saveEditData();
      renderPage(currentPage);
      showToast('封面已更新');
    });
  }

  function changeBadge(modId) {
    var mod = modData.find(function (m) { return m.id === modId; });
    if (!mod) return;
    var badge = prompt('请输入版本号：', mod.badge);
    if (badge !== null) {
      mod.badge = badge.trim();
      saveEditData();
      renderPage(currentPage);
      showToast('版本已更新');
    }
  }

  function addTag(modId) {
    showEditInputDialog('添加标签', '请输入标签名称', '', function (tag) {
      if (!tag) return;
      var mod = baseModData.find(function (m) { return m.id === modId; }) || modData.find(function (m) { return m.id === modId; });
      if (mod) {
        if (!mod.tags) mod.tags = [];
        if (!mod.tags.includes(tag)) {
          mod.tags.push(tag);
          saveEditData();
          renderPage(currentPage);
          if (currentMod && currentMod.id === modId) oM(mod);
          showToast('标签已添加');
        }
      }
    });
  }

  function removeTag(modId, tag) {
    var mod = modData.find(function (m) { return m.id === modId; });
    if (mod && mod.tags) {
      mod.tags = mod.tags.filter(function (t) { return t !== tag; });
      saveEditData();
      renderPage(currentPage);
      if (currentMod && currentMod.id === modId) oM(mod);
      showToast('标签已删除');
    }
  }

  function collapseAllSections() {
    document.querySelectorAll('.sb').forEach(function (sb) {
      sb.classList.add('co');
      sb.style.maxHeight = '';
      var arrow = sb.previousElementSibling;
      if (arrow) {
        var sa2 = arrow.querySelector('.sa2');
        if (sa2) sa2.classList.remove('op');
      }
    });
    if (editToolbar) {
      editToolbar.classList.add('edit-toolbar-collapsed');
      updateToolbarPadding();
    }
  }
  function expandToolbar() {
    if (editToolbar) {
      editToolbar.classList.remove('edit-toolbar-collapsed');
      updateToolbarPadding();
    }
  }
  function updateToolbarPadding() {
    if (!editToolbar) return;
    if (editToolbar.classList.contains('edit-toolbar-collapsed')) {
      document.body.style.paddingTop = '40px';
    } else {
      document.body.style.paddingTop = editToolbar.offsetHeight + 'px';
    }
  }

  // ===== 全局编辑模式暴露 =====
  window._isEditMode = function () { return isEditMode; };
  window._toggleEditMode = toggleEditMode;
})();
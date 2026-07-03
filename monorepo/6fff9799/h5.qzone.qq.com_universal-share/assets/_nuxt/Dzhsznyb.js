import{J as n,Y as u,T as e}from"./LPW56aBP.js";import{u as l}from"./C1l3m8vg.js";import{a as c}from"./DHIOzD2q.js";const a={[e.GROUP_INFO]:"QQ群",[e.CERTIFY_GROUP_SHARE]:"认证QQ群",OTHER:"QQ分享"},d=[e.CERTIFY_GROUP_SHARE,e.ALBUM_SHARE,e.FEED],m="https://qq-web.cdn-go.cn/qui/latest/qui/token.css",g="https://qq-web.cdn-go.cn/qui/latest/qui/default-token.css";function w(){const{host:t}=c(),o=(t==null?void 0:t.includes("test"))||!1,s=n().query.tempid,i=l(),r=d.includes(s);u({title:a[s]||a.OTHER,link:[o?{rel:"preload",href:"https://unpkg.com/vconsole@3.5.2/dist/vconsole.min.js",as:"script"}:{},{href:r?g:m,rel:"stylesheet"}],script:[{innerHTML:`
          (function(){
            function getNavHeight() {
              var ua = navigator.userAgent;
              if (ua.toLowerCase().indexOf('android') > -1) {
                var barProperty = ua.match(/StatusBarHeight\\/[0-9]*/);
                var StatusBarHeight = 24 * window.devicePixelRatio;
                if (barProperty && barProperty[0]) {
                  var no = barProperty[0].indexOf('/');
                  if (no != -1) {
                    StatusBarHeight = parseFloat(barProperty[0].substring(no + 1, barProperty[0].length).trim());
                  }
                }
                if (StatusBarHeight < 20) {
                  StatusBarHeight = 24 * window.devicePixelRatio;
                }
                window._statusBarH = StatusBarHeight / window.devicePixelRatio;
              }
            }

            getNavHeight();

            var img = new Image();
            var tid = setTimeout(function(){
              window.supportWebp2 = false;
                img.onload = img.onerror = null;
                img = null;
            },500);
    
            img.onload = img.onerror = function() {
              clearTimeout(tid);
              window.supportWebp2 = (img.width === 2 && img.height === 2);
            };
            img.src = "data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAACyAgCdASoCAAIALmk0mk0iIiIiIgBoSygABc6WWgAA/veff/0PP8bA//LwYAAA";
          })();
        `},o?{src:"https://unpkg.com/vconsole@3.5.2/dist/vconsole.min.js",onload:"new VConsole();"}:""],bodyAttrs:{class:i==="dark"?"dark":""},htmlAttrs:{class:i==="dark"?"system-theme-darkmode":""}})}export{w as u};

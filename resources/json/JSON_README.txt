
=====================
../resources/json/config.json 各字段说明

loadingGifUrls
--------------
首屏加载动画 GIF
1. http://shp.qpic.cn/collector/1976464052/8ca28b73-c355-4abe-92e8-d4da82b9c560/0 - 腾讯 QQ 图床备用1，图源"QQ收藏"
2. https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRQw4iaPl6ZCFxU66CiaGkhEicLCnEibnfSRX2T4Zhze15Rbg/0 - 腾讯 QQ 图床备用2，图源"名片标签"
3. https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded.gif - jsdmirror CDN 镜像，国内访问较快

logoUrls
--------
页面左上角 LOGO 立绘图片（故障机器人/鸡煲立绘）
1. https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/Lihui_standby.gif - CDN 镜像，国内访问较快
2. https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/Lihui.gif - jsdmirror CDN 镜像，国内访问较快

loaded2GifUrls
--------------
MOD 卡片没有封面图时的占位图（"正在加载"占位动画）
1. http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0 - 腾讯 QQ 图床备用1，图源"QQ收藏"
2. https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRb8kvrUia3vonmc1Qke2xRzZticdf6bkIGYzicc43F7x6RI/0 - 腾讯 QQ 图床备用2，图源"名片标签"
3. https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif - jsdmirror CDN 镜像，国内访问较快

加载逻辑说明
=====================
- 每个图片字段都支持多个 URL 作为备用地址
- 前端使用 raceImage 函数同时请求所有 URL，取最先加载成功的一个
- 单个图片请求超时时间为 3.5 秒，整体竞速总超时为 6.5 秒
- 所有图片加载不阻塞页面显示（页面会在 100ms 后直接展示，图片后台异步更新）
- 如果某个图片字段所有 URL 都加载失败，对应的元素会保持 CSS 默认状态或留空

=====================
manifest.json 说明（新增）

- 每个分区目录下新增 manifest.json，用于声明该分区包含哪些 JSON 数据文件
- 格式：{"分区名": "起始序号~结束序号"}
- 示例：{"sts2_mods": "1~6"} 表示该分区有 sts2_mods_1.json 到 sts2_mods_6.json
- 前端启动时先读取 manifest.json，按需加载对应文件
- 新增/删除数据文件时，只需修改 manifest.json 中的数字范围，无需改前端代码
=====================
# 幼儿园三年成长纪念 H5

直接打开 `index.html` 即可预览页面。

页面打开后会直接展示“今日回忆”：每天从全部素材中固定选择一份，第二天自动更换，并跳过尚未上传的文件。

## 腾讯云 COS 自动同步

线上页面通过 Netlify Function 自动读取以下目录，不区分图片和视频：

- `幼儿园时光/小班/`
- `幼儿园时光/中班/`
- `幼儿园时光/大班/`

存储桶为 `maosery-1257301643`，地域为北京 `ap-beijing`。函数会根据文件扩展名自动判断类型，并使用文件名作为标题。

在 Netlify 的 `Project configuration > Environment variables` 中添加：

- `TENCENT_COS_SECRET_ID`
- `TENCENT_COS_SECRET_KEY`

这两个变量应标记为 Secret，并包含 Builds、Functions 作用域。建议使用仅允许该存储桶 `cos:GetBucket` 和 `cos:GetObject` 的子账号密钥，不要把密钥写入 GitHub 或 `index.html`。

配置完成后，Netlify 上的页面会自动读取 COS，向目录上传或删除素材不需要再次修改网页代码。

直接双击 `index.html` 或使用普通本地静态服务器时，页面会使用下面的本地素材作为预览兜底。要在本地测试 COS 接口，需要链接 Netlify 项目后运行 `netlify dev`。

## 替换照片和视频

把素材按下面的文件名放入对应目录，页面会自动读取：

- 小班照片：`media/small/photo-01.jpg` 到 `photo-06.jpg`
- 中班照片：`media/middle/photo-01.jpg` 到 `photo-06.jpg`
- 大班照片：`media/large/photo-01.jpg` 到 `photo-06.jpg`
- 视频：`media/videos/small-01.mp4`、`middle-01.mp4`、`large-01.mp4` 等

视频不需要另做封面。页面会读取视频，并自动停在前 2.5 秒附近作为封面，同时读取视频时长。

如果照片、视频数量、标题或年份需要调整，编辑 `index.html` 底部脚本里的 `album` 数据即可。数组里可以继续添加任意数量的素材：

```js
photos: [
  ["media/small/photo-01.jpg", "入园第一天"]
],
videos: [
  ["media/videos/small-01.mp4", "第一次上台", 2.5]
]
```

视频最后一个数字是封面截取时间，单位为秒。每日回忆会自动从这里配置的全部照片和视频中轮换选择。

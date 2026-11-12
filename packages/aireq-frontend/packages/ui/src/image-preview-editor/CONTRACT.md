# 图片预览编辑

图片原字节只读；transform 和标注历史由当前预览唯一持有。存在未保存标注或撤销历史时，关闭按钮、Escape、背景关闭和切图均先询问保存／丢弃／取消；取消不卸载编辑器，保留标注及历史，明确丢弃后才销毁。
保存捕获 focused Composer receiver 后异步导出自然尺寸 PNG；接收方释放 scope 后必须拒绝旧 receiver。
`registerImageComposerTarget` 由 Composer 的附件 hook 注册，仍以既有 `addAttachmentFiles` 为唯一入队路径。
编辑器不持有上传队列，不发送消息，不调用主进程。缩放、选择和擦除均在自然像素坐标中进行。
保存到对话只新增标注 PNG 副本，不替换原图、不自动发送；保存失败保留编辑及关闭确认。下载按钮明确下载原图（不含当前标注），原图下载不清除未保存状态。浏览器保存端口成功但未返回本地路径时只反馈“已开始下载”，不误报落盘成功或重试下载。
详见 [spec](../../../../docs/ui/shared-image-preview-dialog.md)。

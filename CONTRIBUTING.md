# Contributing to QCpet

感谢参与 QCpet。提交改动前，请先创建 Issue 或在 Pull Request 中说明使用场景和预期行为。

## 本地检查

```powershell
npm ci
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

涉及界面、PSD 装配或动作的改动，请至少使用默认模型和一个外部导入 PSD 手动验证，并在 Pull Request 中写明模型结构和测试结果。

## 资源与隐私

- 不要提交 API Key、对话记录、用户目录或日志。
- 不要提交没有明确再分发许可的 PSD、图片、声音或字体。
- PSD 渲染必须统一走自动装配参数，不按模型文件名或模型身份增加专用分支。

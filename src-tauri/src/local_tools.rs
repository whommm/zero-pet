//! 零的桌宠 · 本地工具执行器
//! 处理来自 gateway 的 desktop.tool_call：打开应用 / 截屏 / 文件 / 剪贴板。
//! 每个函数返回统一形状：{"ok": true, ...} 或 {"ok": false, "error": "..."}

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use image::GenericImageView;
use serde_json::{json, Value};

/// Windows 上把路径里的正斜杠转成 Windows 反斜杠（仅当路径已含盘符且用户可能输入 / 分隔）
fn normalize_windows_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"');
    let has_drive = trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':';
    if has_drive {
        trimmed.replace('/', "\\")
    } else {
        trimmed.to_string()
    }
}

/// 打开应用 / 文件 / URL（Windows 默认程序）
#[tauri::command]
pub fn local_open_app(target: String, args: Option<Vec<String>>) -> Value {
    let target = normalize_windows_path(&target);
    if target.is_empty() {
        return json!({"ok": false, "error": "target 不能为空"});
    }
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg("start").arg("").arg(&target);
    for a in args.unwrap_or_default() {
        cmd.arg(a);
    }
    match cmd.output() {
        Ok(_) => json!({"ok": true, "opened": target}),
        Err(e) => json!({"ok": false, "error": format!("打开失败: {e}")}),
    }
}

/// 截屏：full=true 截所有屏幕拼一张，否则只截主屏。返回 PNG 保存路径。
#[tauri::command]
pub fn local_screenshot(full: Option<bool>) -> Value {
    let full = full.unwrap_or(false);
    let result = (|| -> Result<String, String> {
        let screenshots = screenshots::Screen::all().map_err(|e| format!("枚举屏幕失败: {e}"))?;
        let (w, h) = if full {
            let max_x = screenshots.iter().map(|s| s.display_info.x as i32 + s.display_info.width as i32).max().unwrap_or(0);
            let max_y = screenshots.iter().map(|s| s.display_info.y as i32 + s.display_info.height as i32).max().unwrap_or(0);
            (max_x as u32, max_y as u32)
        } else {
            let primary = screenshots.iter().find(|s| s.display_info.is_primary)
                .or_else(|| screenshots.first())
                .ok_or("没有可用屏幕")?;
            (primary.display_info.width, primary.display_info.height)
        };
        let mut image = image::RgbaImage::new(w, h);
        for s in &screenshots {
            let info = &s.display_info;
            if full || info.is_primary {
                let img = s.capture().map_err(|e| format!("截屏失败: {e}"))?;
                let (ox, oy) = (info.x, info.y);
                for (x, y, p) in img.enumerate_pixels() {
                    let dx = x as i32 - ox;
                    let dy = y as i32 - oy;
                    if dx >= 0 && dy >= 0 && dx < w as i32 && dy < h as i32 {
                        image.put_pixel(dx as u32, dy as u32, *p);
                    }
                }
            }
        }
        let data_dir = tauri::api::path::picture_dir()
            .or_else(|| dirs::picture_dir())
            .unwrap_or_else(|| PathBuf::from("."));
        let dir = data_dir.join("ZeroPet");
        fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
        let path = dir.join(format!("screenshot_{}.png", chrono_now_ts()));
        image.save(&path).map_err(|e| format!("保存图片失败: {e}"))?;
        Ok(path.to_string_lossy().to_string())
    })();
    match result {
        Ok(path) => json!({"ok": true, "path": path}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

fn chrono_now_ts() -> String {
    // 轻量时间戳（不引入 chrono，用系统时间格式化）
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string()
}

/// 文件操作：list / read / write
#[tauri::command]
pub fn local_file(action: String, path: String, content: Option<String>) -> Value {
    let path = normalize_windows_path(&path);
    if path.is_empty() {
        return json!({"ok": false, "error": "path 不能为空"});
    }
    match action.as_str() {
        "list" => {
            let dir = Path::new(&path);
            if !dir.is_dir() {
                return json!({"ok": false, "error": format!("不是目录: {path}")});
            }
            let mut items: Vec<Value> = Vec::new();
            match fs::read_dir(dir) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let is_dir = entry.path().is_dir();
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        items.push(json!({"name": name, "dir": is_dir, "size": size}));
                    }
                    items.sort_by(|a, b| {
                        let ad = a["dir"].as_bool().unwrap_or(false);
                        let bd = b["dir"].as_bool().unwrap_or(false);
                        bd.cmp(&ad).then(a["name"].as_str().cmp(&b["name"].as_str()))
                    });
                    json!({"ok": true, "path": path, "count": items.len(), "items": items})
                }
                Err(e) => json!({"ok": false, "error": format!("列目录失败: {e}")}),
            }
        }
        "read" => {
            match fs::read_to_string(&path) {
                Ok(text) => {
                    let max_chars = 200_000;
                    let truncated = text.chars().count() > max_chars;
                    let text: String = text.chars().take(max_chars).collect();
                    json!({"ok": true, "path": path, "chars": text.chars().count(), "truncated": truncated, "content": text})
                }
                Err(e) => {
                    // 可能是二进制文件，读字节转 base64 摘要
                    match fs::read(&path) {
                        Ok(bytes) => json!({"ok": true, "path": path, "binary": true, "size": bytes.len(), "sha1": short_sha1(&bytes)}),
                        Err(_) => json!({"ok": false, "error": format!("读文件失败: {e}")}),
                    }
                }
            }
        }
        "write" => {
            let text = content.unwrap_or_default();
            let max_len = 5 * 1024 * 1024;
            if text.len() > max_len {
                return json!({"ok": false, "error": format!("内容过大（>{} 字节）", max_len)});
            }
            match fs::write(&path, &text) {
                Ok(()) => json!({"ok": true, "path": path, "bytes": text.len()}),
                Err(e) => json!({"ok": false, "error": format!("写文件失败: {e}")}),
            }
        }
        other => json!({"ok": false, "error": format!("未知文件操作: {other}")}),
    }
}

fn short_sha1(bytes: &[u8]) -> String {
    // 极简摘要（不引入 sha1 crate 时的兜底）
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes.iter().take(1_000_000) {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

/// 剪贴板：read / write
#[tauri::command]
pub fn local_clipboard(action: String, content: Option<String>) -> Value {
    match action.as_str() {
        "read" => match arboard::Clipboard::new() {
            Ok(mut cb) => match cb.get_text() {
                Ok(text) => json!({"ok": true, "chars": text.chars().count(), "content": text}),
                Err(e) => json!({"ok": false, "error": format!("读剪贴板失败: {e}")}),
            },
            Err(e) => json!({"ok": false, "error": format!("打开剪贴板失败: {e}")}),
        },
        "write" => {
            let text = content.unwrap_or_default();
            let bytes = text.len();
            match arboard::Clipboard::new() {
                Ok(mut cb) => match cb.set_text(text) {
                    Ok(()) => json!({"ok": true, "bytes": bytes}),
                    Err(e) => json!({"ok": false, "error": format!("写剪贴板失败: {e}")}),
                },
                Err(e) => json!({"ok": false, "error": format!("打开剪贴板失败: {e}")}),
            }
        }
        other => json!({"ok": false, "error": format!("未知剪贴板操作: {other}")}),
    }
}

/// 本地系统通知（Windows toast，经 PowerShell 简单实现）
#[tauri::command]
pub fn local_notify(title: Option<String>, body: String) -> Value {
    let title = title.unwrap_or_else(|| "零的桌宠".to_string());
    // PowerShell 弹 toast 通知（Windows 10+）
    let ps = format!(
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; \
         $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); \
         $textNodes = $template.GetElementsByTagName('text'); \
         $textNodes.Item(0).AppendChild($template.CreateTextNode('{}')) > $null; \
         $textNodes.Item(1).AppendChild($template.CreateTextNode('{}')) > $null; \
         $toast = [Windows.UI.Notifications.ToastNotification]::new($template); \
         [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ZeroPet').Show($toast)",
        escape_ps(&title), escape_ps(&body)
    );
    match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .output()
    {
        Ok(_) => json!({"ok": true, "title": title, "body": body}),
        Err(e) => json!({"ok": false, "error": format!("通知失败: {e}")}),
    }
}

fn escape_ps(text: &str) -> String {
    text.replace('\'', "''")
}

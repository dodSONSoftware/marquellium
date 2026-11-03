//! Offline exports. DOCX uses the same dialect AST mapped by the frontend,
//! with bounded typed blocks; Rust owns OOXML, embedded assets and file writes.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::Mutex,
};

#[derive(Clone, Deserialize, Serialize)]
pub struct Run {
    pub text: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub code: bool,
    #[serde(default)]
    pub strike: bool,
    pub href: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Block {
    Paragraph {
        runs: Vec<Run>,
        heading: Option<u8>,
        quote: Option<bool>,
    },
    Table {
        rows: Vec<Vec<Vec<Run>>>,
    },
    Image {
        href: String,
        alt: String,
    },
}
#[derive(Default)]
pub struct PrintPreviews(pub Mutex<HashMap<String, String>>);

pub fn image(
    document: &Path,
    href: &str,
    workspace: Option<&Path>,
) -> Result<(String, Vec<u8>), String> {
    let (path, _) = crate::workspace::resolve_link(document, workspace, href)?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Export image exceeds 8 MiB".into());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err(
            "Export embeds PNG/JPEG/GIF/WebP only; image source will remain visible".into(),
        );
    };
    Ok((mime.into(), bytes))
}
pub fn image_uri(document: &Path, href: &str, workspace: Option<&Path>) -> Result<String, String> {
    let (mime, bytes) = image(document, href, workspace)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
fn xml(s: &str) -> String {
    s.chars()
        .filter(|c| {
            *c == '\n'
                || *c == '\r'
                || *c == '\t'
                || *c >= ' ' && *c != '\u{fffe}' && *c != '\u{ffff}'
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn runs(runs: &[Run], relationships: &mut Vec<(String, String, bool)>) -> String {
    runs.iter()
        .map(|r| {
            let properties = format!(
                "{}{}{}{}",
                if r.bold { "<w:b/>" } else { "" },
                if r.italic { "<w:i/>" } else { "" },
                if r.strike { "<w:strike/>" } else { "" },
                if r.code {
                    "<w:rFonts w:ascii=\"Courier New\" w:hAnsi=\"Courier New\"/>"
                } else {
                    ""
                }
            );
            let text = r
                .text
                .split('\n')
                .map(|line| format!("<w:t xml:space=\"preserve\">{}</w:t>", xml(line)))
                .collect::<Vec<_>>()
                .join("<w:br/>");
            let run = format!("<w:r><w:rPr>{properties}</w:rPr>{text}</w:r>");
            if let Some(href) = r.href.as_ref().filter(|s| {
                !s.contains(':')
                    || s.starts_with("https://")
                    || s.starts_with("http://")
                    || s.starts_with("mailto:")
            }) {
                let id = format!("rId{}", relationships.len() + 1);
                relationships.push((id.clone(), href.clone(), false));
                format!("<w:hyperlink r:id=\"{id}\">{run}</w:hyperlink>")
            } else {
                run
            }
        })
        .collect()
}
fn paragraph(text: &str) -> String {
    format!(
        "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        xml(text)
    )
}

pub fn docx(
    blocks: &[Block],
    document: Option<&Path>,
    workspace: Option<&Path>,
) -> Result<Vec<u8>, String> {
    let encoded = serde_json::to_vec(blocks).map_err(|e| e.to_string())?;
    if encoded.len() > 8 * 1024 * 1024 || blocks.len() > 20_000 {
        return Err("DOCX content limit exceeded".into());
    }
    let mut body = String::new();
    let mut relationships = Vec::new();
    let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
    let mut images = 0;
    for block in blocks {
        match block {
            Block::Paragraph {
                runs: text,
                heading,
                quote,
            } => {
                let style = heading
                    .filter(|h| (1..=6).contains(h))
                    .map_or(String::new(), |h| {
                        format!("<w:pStyle w:val=\"Heading{h}\"/>")
                    });
                let indent = if quote.unwrap_or(false) {
                    "<w:ind w:left=\"720\"/>"
                } else {
                    ""
                };
                body.push_str(&format!(
                    "<w:p><w:pPr>{style}{indent}</w:pPr>{}</w:p>",
                    runs(text, &mut relationships)
                ));
            }
            Block::Table { rows } => {
                if rows.len() > 1000 || rows.iter().any(|r| r.len() > 100) {
                    return Err("DOCX table exceeds 1000 rows / 100 columns".into());
                }
                body.push_str("<w:tbl><w:tblPr><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\"/><w:bottom w:val=\"single\" w:sz=\"4\"/><w:insideH w:val=\"single\" w:sz=\"4\"/><w:insideV w:val=\"single\" w:sz=\"4\"/></w:tblBorders></w:tblPr>");
                for row in rows {
                    body.push_str("<w:tr>");
                    for cell in row {
                        body.push_str(&format!(
                            "<w:tc><w:p>{}</w:p></w:tc>",
                            runs(cell, &mut relationships)
                        ));
                    }
                    body.push_str("</w:tr>");
                }
                body.push_str("</w:tbl>");
            }
            Block::Image { href, alt } => {
                let loaded = document
                    .ok_or_else(|| "Unsaved document".to_string())
                    .and_then(|p| image(p, href, workspace));
                if let Ok((mime, bytes)) = loaded {
                    if mime == "image/png" && bytes.len() >= 24 {
                        if parts.iter().map(|(_, data)| data.len()).sum::<usize>() + bytes.len()
                            > 24 * 1024 * 1024
                        {
                            return Err("DOCX image payload exceeds 24 MiB".into());
                        }
                        images += 1;
                        if images > 100 {
                            return Err("DOCX image limit exceeded".into());
                        }
                        let width =
                            u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| "PNG width")?)
                                .max(1);
                        let height =
                            u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| "PNG height")?)
                                .max(1);
                        let cx = (u64::from(width) * 9525).min(5_500_000);
                        let cy = (cx * u64::from(height) / u64::from(width)).min(8_000_000);
                        let name = format!("media/image{images}.png");
                        let id = format!("rId{}", relationships.len() + 1);
                        relationships.push((id.clone(), name.clone(), true));
                        parts.push((format!("word/{name}"), bytes));
                        body.push_str(&format!("<w:p><w:r><w:drawing><wp:inline><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{images}\" name=\"Image {images}\" descr=\"{}\"/><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{images}\" name=\"Image\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"{id}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",xml(alt)));
                        continue;
                    }
                }
                body.push_str(&paragraph(&format!(
                    "Image source (DOCX fallback): {alt} ({href})"
                )));
            }
        }
    }
    let doc = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1020" w:right="1020" w:bottom="1020" w:left="1020"/></w:sectPr></w:body></w:document>"#
    );
    parts.push(("word/document.xml".into(), doc.into_bytes()));
    let rels=relationships.iter().map(|(id,target,image)|format!(r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{}" Target="{}"{}/>"#,if *image {"image"}else{"hyperlink"},xml(target),if *image {""}else{" TargetMode=\"External\""})).collect::<String>();
    parts.push(("word/_rels/document.xml.rels".into(),format!(r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>{rels}</Relationships>"#).into_bytes()));
    let headings=(1..=6).map(|h|format!(r#"<w:style w:type="paragraph" w:styleId="Heading{h}"><w:name w:val="heading {h}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="{}"/></w:pPr><w:rPr><w:b/><w:sz w:val="{}"/></w:rPr></w:style>"#,h-1,40-h*3)).collect::<String>();
    parts.push(("word/styles.xml".into(),format!(r#"<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>{headings}</w:styles>"#).into_bytes()));
    parts.push(("[Content_Types].xml".into(),br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>"#.to_vec()));
    parts.push(("_rels/.rels".into(),br#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#.to_vec()));
    zip(parts)
}
/// Small ZIP writer using the stored method (no compression/dependency). All
/// entry names are application-generated. CRC/central directory are standard ZIP.
fn zip(parts: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, String> {
    fn u16le(out: &mut Vec<u8>, v: u16) {
        out.extend(v.to_le_bytes());
    }
    fn u32le(out: &mut Vec<u8>, v: u32) {
        out.extend(v.to_le_bytes());
    }
    let mut out = Vec::new();
    let mut central = Vec::new();
    let count = parts.len() as u16;
    for (name, data) in parts {
        if out.len() + data.len() > 32 * 1024 * 1024 {
            return Err("DOCX exceeds 32 MiB".into());
        }
        let offset = out.len() as u32;
        let size = data.len() as u32;
        let mut crc = 0xffffffffu32;
        for b in &data {
            crc ^= u32::from(*b);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320u32 & 0u32.wrapping_sub(crc & 1));
            }
        }
        crc = !crc;
        u32le(&mut out, 0x04034b50);
        for v in [20, 0, 0, 0, 0] {
            u16le(&mut out, v);
        }
        u32le(&mut out, crc);
        u32le(&mut out, size);
        u32le(&mut out, size);
        u16le(&mut out, name.len() as u16);
        u16le(&mut out, 0);
        out.extend(name.as_bytes());
        out.extend(data);
        u32le(&mut central, 0x02014b50);
        for v in [20, 20, 0, 0, 0, 0] {
            u16le(&mut central, v);
        }
        for v in [crc, size, size] {
            u32le(&mut central, v);
        }
        u16le(&mut central, name.len() as u16);
        for _ in 0..4 {
            u16le(&mut central, 0);
        }
        u32le(&mut central, 0);
        u32le(&mut central, offset);
        central.extend(name.as_bytes());
    }
    let start = out.len() as u32;
    let size = central.len() as u32;
    out.extend(central);
    u32le(&mut out, 0x06054b50);
    u16le(&mut out, 0);
    u16le(&mut out, 0);
    u16le(&mut out, count);
    u16le(&mut out, count);
    u32le(&mut out, size);
    u32le(&mut out, start);
    u16le(&mut out, 0);
    Ok(out)
}
pub fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Unique sibling temp plus rename; a failed export never truncates its target.
    let parent = path.parent().ok_or("Export has no parent")?;
    let name = format!(
        ".marquellium-export-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let temp = parent.join(name);
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&temp, path)
    })()
    .map_err(|e: std::io::Error| e.to_string());
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(text: &str) -> Run {
        Run {
            text: text.into(),
            bold: true,
            italic: false,
            code: false,
            strike: false,
            href: Some("https://example.com/?x=1&y=2".into()),
        }
    }
    #[test]
    fn docx_contains_ooxml_styles_tables_links_and_visible_fallbacks() {
        let blocks = vec![
            Block::Paragraph {
                runs: vec![run("東京 & <heading>\nnext")],
                heading: Some(2),
                quote: None,
            },
            Block::Table {
                rows: vec![vec![vec![run("Ada")]]],
            },
            Block::Image {
                href: "missing.png".into(),
                alt: "missing diagram".into(),
            },
        ];
        let output = docx(&blocks, None, None).unwrap();
        assert!(output.starts_with(b"PK\x03\x04"));
        let text = String::from_utf8_lossy(&output);
        for expected in [
            "東京 &amp; &lt;heading&gt;",
            "<w:br/>",
            "Heading2",
            "<w:tbl>",
            "Ada",
            "hyperlink",
            "missing diagram",
            "[Content_Types].xml",
            "word/styles.xml",
        ] {
            assert!(text.contains(expected), "{expected}");
        }
        assert_eq!(xml("x\0\u{1}<"), "x&lt;");
    }
    #[test]
    fn export_writes_atomically_and_never_reads_outside_document_scope() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = root.path().join("a.md");
        std::fs::write(&source, "original").unwrap();
        std::fs::write(outside.path().join("a.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        assert!(image(&source, "https://example.com/a.png", None).is_err());
        assert!(image(&source, "../a.png", None).is_err());
        let destination = root.path().join("a.docx");
        write(&destination, b"first").unwrap();
        write(&destination, b"second").unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), b"second");
        assert_eq!(std::fs::read_to_string(source).unwrap(), "original");
    }
}

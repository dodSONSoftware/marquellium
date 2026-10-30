# Unicode Fixture

Every code-point class the offset/encoding boundary must survive (FR-051, AT-116).

## CJK

# 日本語の見出し
## 中文标题
### 한국어 제목

正文テキストを含む段落。日本語、中文、한국어 の混在。

- 项目一
- 项目二
- 항목 하나

## Combining characters

Accented: café (precomposed) vs café (decomposed) — both forms.
Hindi: नमस्ते
Devanagari with matras: संस्कृतम्
Greek: ψεύδος
Cyrillic: псевдоним

## Emoji and ZWJ sequences

Simple: 😀 😊 🎉 🚀
Family ZWJ: 👨‍👩‍👧‍👦
Flag: 🏳️‍🌈
Combined: 👩‍💻 🧑‍🚀 ✍️

In a list:

- 😀 item one
- 👨‍👩‍👧‍👦 item two (ZWJ sequence at line start after marker)

## Right-to-left

Hebrew: שלום עולם
Arabic: مرحبا بالعالم
Mixed: the word "בית" inside Latin text.

## Special whitespace and invisible

Zero-width space between: invis‌ible
Right-to-left mark at end of a line: Latin←
Soft hyphen: com-puting

## Surrogate pairs (astral plane)

BMP edge: ⿰ (U+2FA0, high surrogate territory)
Astral: 𝕷 (U+1D537), 𐐷 (U+10437), 𝟘 (U+1D7D8)
Math alphanumerics: 𝓪𝓫𝓬

## Table with Unicode

| 日本語 | العربية | עברית |
|:------:|:-------:|:-----:|
| 東京   | بيروت   | ירושלים |

## Headings with Unicode (TOC stability)

## Café
## Café (combining form — duplicate of above)
## Über
## 你好
## Ωmega
## Ωmega (duplicate Latin spelling)

## Code blocks with Unicode

```python
# 日本語コメント
café = "café"
emoji = "👨‍👩‍👧‍👦"
print(café, emoji)
```

End of Unicode fixture.

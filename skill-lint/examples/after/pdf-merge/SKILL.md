---
name: pdf-merge
description: 合并、拆分、旋转 PDF 并给页面加水印。当用户说"把这两个 PDF 合成一个""按章节拆开""把这页转正""给整份文件打水印"时使用。只处理本地已有的 PDF；不适用于扫描件文字识别（那要用 OCR 技能）、不适用于 PDF 与 Word 互转（那要用格式转换技能）。
license: MIT
---

# PDF 合并与拆分

## 什么时候用

用户手上有**已经生成的 PDF**，要动它的页序、页数或页码装饰。

## 什么时候不该用

| 用户其实想要 | 该去哪个技能 |
|---|---|
| 扫描件里的文字提取 | `pdf-ocr` |
| PDF 转 Word / Word 转 PDF | `format-convert` |
| 编辑 PDF 里的文字内容 | 本技能不做，直接告诉用户需要专业工具 |

## 合并

```bash
python scripts/merge.py a.pdf b.pdf -o out.pdf
```

## 拆分

```bash
python scripts/split.py in.pdf --pages 1-5 -o part.pdf
```

## 参数与错误码

见 `references/api.md`。

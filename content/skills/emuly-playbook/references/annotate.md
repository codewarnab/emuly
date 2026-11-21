# Annotate a recording: trim it and add step captions

Use this whenever the user asks for annotations, captions, labels or a "trimmed" or
"cleaned up" video, and for every before/after video you put in a PR or issue. Always use
this style. Do not draw plain `drawtext` boxes instead.

The look: a dark pill badge at the top ("BEFORE · develop" with a red dot, or
"AFTER · this PR" with a green dot), and a rounded dark caption card at the bottom with a
numbered circle, a bold title and a smaller detail line. The last step (the key moment) gets
a coloured bar, number and detail. Each caption fades in and slides up. The font is Inter.

## Needs

`ffmpeg`, `ffprobe`, Python 3 and Pillow (`pip install pillow`, or `apt install python3-pil`).
Ask before you install any of them. The script downloads the Inter font once into
`~/.cache/emuly/fonts`. If that fails, it uses DejaVu and still works.

## Steps

1. Record with the recording route (`references/screenshots.md`). Use `{"quality":"native"}`,
   so the text in the video is sharp. Add a note after each step with `recording/mark`. Pause
   about 1 second on each screen, so each step has a clear moment.
2. Find the moments to keep. If you added notes while you recorded, `GET .../recording/notes`
   gives each step's time in the video; start each step at its note time. Otherwise, get a frame grid (`/recording/grid?fps=2`), or run
   `ffmpeg -i in.mp4 -vf freezedetect=n=0.003:d=1 -map 0:v -f null -` to find still parts.
   Keep 2 to 4 seconds per step. Cut the waits between steps.
3. Save the script below as `emuly-annotate.py` in the scratchpad, then run it:

   ```bash
   python3 emuly-annotate.py in.mp4 out.mp4 "BEFORE  ·  develop" before \
     "2.5|6.0|Open the Student profile" \
     "15.8|19.0|Tap FORGOT PIN?" \
     "28.6|31.0|Type a wrong admin PIN|99999" \
     "40.4|46.0|Submit|The error shows, but the wrong PIN stays in the box"
   ```

   - Argument 3 is the badge text. Argument 4 is `before` (red) or `after` (green).
   - Each step is `start|end|title|detail`, in seconds of the input. `detail` is optional.
   - The last step is the key moment. Start any other detail with `!` to mark it the same way.
   - Titles: 2 to 5 words, an action ("Tap Submit"). Details: what the viewer should notice.
4. Grab one frame from each step (`ffmpeg -ss <t> -i out.mp4 -frames:v 1 f.png`) and look at
   them. Check that the text fits and the card does not hide the thing the step shows.
5. Show the video as described in `references/screenshots.md`.

For a before/after pair, use the same step titles in both videos, so a reviewer can compare
them side by side.

## The script

```python
#!/usr/bin/env python3
"""Trim a screen recording and add polished step captions.

usage: emuly-annotate.py in.mp4 out.mp4 "LABEL" before|after  "start|end|title|detail" ...
  - label: badge text at the top, e.g. "BEFORE · develop"
  - tone:  before (red accent) or after (green accent)
  - each segment: keep start..end seconds, show a caption card with a
    step number, a bold title and an optional smaller detail line.
Overlays are drawn with Pillow (3x supersampled, so edges are smooth) and
composited by ffmpeg with a short fade and slide-in.
"""
import os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_DIR = os.path.expanduser("~/.cache/emuly/fonts")
INTER = "https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip"

def get_inter():
    """Download Inter once into ~/.cache/emuly/fonts. Falls back to DejaVu on failure."""
    if os.path.exists(f"{FONT_DIR}/Inter-SemiBold.ttf"): return
    import io, urllib.request, zipfile
    try:
        os.makedirs(FONT_DIR, exist_ok=True)
        z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(INTER, timeout=60).read()))
        for n in z.namelist():
            if n.endswith(("/Inter-Medium.ttf", "/Inter-SemiBold.ttf", "/Inter-Bold.ttf")) and "extras/ttf" in n:
                open(f"{FONT_DIR}/{os.path.basename(n)}", "wb").write(z.read(n))
    except Exception as e:
        print(f"Inter download failed ({e}); using DejaVu", file=sys.stderr)

def font(weight, size):
    for p in (f"{FONT_DIR}/Inter-{weight}.ttf",
              f"/usr/share/fonts/truetype/dejavu/DejaVuSans{'-Bold' if weight != 'Medium' else ''}.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)

TONES = {"before": (229, 72, 77), "after": (48, 164, 108)}
S = 3  # supersample factor

def probe(src):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", src]).decode()
    return map(int, out.strip().split(","))

def wrap(draw, text, f, maxw):
    lines, cur = [], ""
    for word in text.split():
        t = (cur + " " + word).strip()
        if draw.textlength(t, font=f) <= maxw: cur = t
        else: lines.append(cur); cur = word
    return lines + [cur]

def shadowed(card, radius, box, W, H):
    """Paste a soft drop shadow under the card area."""
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(sh).rounded_rectangle((x0, y0 + 6*S, x1, y1 + 6*S), radius, fill=(0, 0, 0, 110))
    return Image.alpha_composite(sh.filter(ImageFilter.GaussianBlur(10*S)), card)

def badge(label, tone, w, h):
    W, H = w*S, h*S
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    f = font("SemiBold", 15*S)
    tw = d.textlength(label, font=f); dot = 9*S; pad = 14*S
    bw, bh = int(tw + dot + pad*2 + 8*S), 34*S
    x0, y0 = (W - bw)//2, 16*S
    d.rounded_rectangle((x0, y0, x0+bw, y0+bh), bh//2, fill=(17, 19, 24, 225), outline=(255, 255, 255, 40), width=S)
    cy = y0 + bh//2
    d.ellipse((x0+pad, cy-dot//2, x0+pad+dot, cy+dot//2), fill=TONES[tone] + (255,))
    d.text((x0+pad+dot+8*S, cy), label, font=f, fill=(255, 255, 255, 245), anchor="lm")
    return shadowed(im, bh//2, (x0, y0, x0+bw, y0+bh), W, H).resize((w, h), Image.LANCZOS)

def caption(n, title, detail, tone, accent, w, h):
    W, H = w*S, h*S
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    m, pad, r = 18*S, 16*S, 16*S
    ft, fd, fn = font("SemiBold", 19*S), font("Medium", 15*S), font("Bold", 15*S)
    circ = 30*S
    textw = W - 2*m - 2*pad - circ - 12*S
    tl = wrap(d, title, ft, textw); dl = wrap(d, detail, fd, textw) if detail else []
    lh_t, lh_d = 25*S, 21*S
    ch = pad*2 + len(tl)*lh_t + (len(dl)*lh_d + 4*S if dl else 0)
    ch = max(ch, circ + 2*pad)
    x0, y1 = m, H - 34*S; y0 = y1 - ch; x1 = W - m
    col = TONES[tone]
    d.rounded_rectangle((x0, y0, x1, y1), r, fill=(17, 19, 24, 235), outline=(255, 255, 255, 36), width=S)
    if accent:  # coloured left bar for the key moment
        d.rounded_rectangle((x0, y0, x0 + 5*S, y1), 2*S, fill=col + (255,))
    cx, cy = x0 + pad, y0 + pad
    d.ellipse((cx, cy, cx+circ, cy+circ), fill=(col + (255,)) if accent else (255, 255, 255, 235))
    d.text((cx+circ/2, cy+circ/2), str(n), font=fn, fill=(255, 255, 255) if accent else (17, 19, 24), anchor="mm")
    tx, ty = cx + circ + 12*S, y0 + pad + 2*S
    for i, line in enumerate(tl):
        d.text((tx, ty + i*lh_t), line, font=ft, fill=(255, 255, 255, 250), anchor="lt")
    ty += len(tl)*lh_t + 4*S
    for i, line in enumerate(dl):
        d.text((tx, ty + i*lh_d), line, font=fd, fill=(col if accent else (190, 196, 206)) + (255,), anchor="lt")
    return shadowed(im, r, (x0, y0, x1, y1), W, H).resize((w, h), Image.LANCZOS)

def main():
    src, out, label, tone = sys.argv[1:5]
    segs = [a.split("|") for a in sys.argv[5:]]
    get_inter()
    w, h = probe(src)
    tmp = tempfile.mkdtemp(dir=os.path.dirname(os.path.abspath(out)))
    bpath = f"{tmp}/badge.png"; badge(label, tone, w, h).save(bpath)
    parts = []
    for i, seg in enumerate(segs):
        a, b, title = seg[:3]; detail = seg[3] if len(seg) > 3 else ""
        accent = i == len(segs) - 1 or detail.startswith("!")
        detail = detail.lstrip("!")
        cpath = f"{tmp}/c{i}.png"; caption(i+1, title, detail, tone, accent, w, h).save(cpath)
        p = f"{tmp}/p{i}.mp4"; parts.append(p)
        # caption fades in and slides up 12px over 0.25s at the start of each step
        fc = ("[2:v]format=rgba,fade=in:st=0:d=0.25:alpha=1[c];"
              "[0:v][1:v]overlay=0:0:shortest=1[v1];"
              "[v1][c]overlay=0:'12*max(0,1-t/0.25)':shortest=1,format=yuv420p")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", a, "-to", b, "-i", src,
            "-loop", "1", "-i", bpath, "-loop", "1", "-i", cpath,
            "-filter_complex", fc, "-an", "-r", "30", "-c:v", "libx264", "-crf", "20",
            "-pix_fmt", "yuv420p", p], check=True)
    lst = f"{tmp}/list.txt"; open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
        "-c", "copy", "-movflags", "+faststart", out], check=True)

if __name__ == "__main__":
    main()
```

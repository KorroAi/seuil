# Draws docs/images/savings.svg from the bench output (paper/PAPER.md, table 2). No dependency.
#   python docs/images/make_chart.py
from pathlib import Path

T = [120, 150, 180, 200, 220, 250, 300, 400]
SERIES = [
    ('no forgetting', '1', [37.8, 37.6, 37.0, 36.2, 35.1, 34.1, 31.6, 25.2]),
    ('20 k re-read', '2', [33.3, 33.5, 33.7, 33.4, 32.7, 31.5, 29.8, 24.1]),
    ('50 k re-read', '3', [27.8, 27.8, 27.8, 28.4, 28.5, 28.4, 26.7, 22.2]),
]
W, H = 800, 400
X0, X1, Y0, Y1 = 64, 600, 330, 70  # plot box (Y0 = baseline)
x = lambda t: X0 + (t - 100) / 300 * (X1 - X0)
y = lambda v: Y0 - v / 40 * (Y0 - Y1)

out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">',
       '<title id="t">Simulated saving by compaction threshold</title>',
       '<desc id="d">Share of the real cost saved on 144 recorded sessions, for thresholds from 120 k to 400 k tokens, under three assumptions about what must be re-read after a compaction. Between 150 k and 250 k the saving stays within about a point; it falls past 300 k.</desc>',
       '''<style>
  .bg{fill:#ffffff}.ink{fill:#1f2328}.muted{fill:#59636e}.grid{stroke:#d1d9e0}.axis{stroke:#59636e}
  .l1{stroke:#2a78d6;fill:none}.l2{stroke:#eb6834;fill:none}.l3{stroke:#1baf7a;fill:none}.d1{fill:#2a78d6}.d2{fill:#eb6834}.d3{fill:#1baf7a}
  @media (prefers-color-scheme: dark){
    .bg{fill:#0d1117}.ink{fill:#f0f6fc}.muted{fill:#9198a1}.grid{stroke:#262c36}.axis{stroke:#9198a1}
    .l1{stroke:#3987e5}.l2{stroke:#d95926}.l3{stroke:#199e70}.d1{fill:#3987e5}.d2{fill:#d95926}.d3{fill:#199e70}
  }
  text{font-size:13px}.title{font-size:16px;font-weight:600}
</style>''',
       f'<rect class="bg" width="{W}" height="{H}" rx="8"/>',
       f'<text class="ink title" x="{X0 - 40}" y="30">Share of the cost saved, by threshold</text>',
       f'<text class="muted" x="{X0 - 40}" y="50">Replay of 144 real sessions (33,634 model calls). Lines differ by what must be re-read after each compaction.</text>']

for v in range(0, 41, 10):
    out.append(f'<line class="grid" x1="{X0}" x2="{X1}" y1="{y(v):.1f}" y2="{y(v):.1f}" stroke-width="1"/>')
    out.append(f'<text class="muted" x="{X0 - 8}" y="{y(v) + 4:.1f}" text-anchor="end">{v} %</text>')
for t in range(100, 401, 50):
    out.append(f'<text class="muted" x="{x(t):.1f}" y="{Y0 + 20}" text-anchor="middle">{t} k</text>')
out.append(f'<line class="axis" x1="{X0}" x2="{X1}" y1="{Y0}" y2="{Y0}" stroke-width="1"/>')
out.append(f'<text class="muted" x="{(X0 + X1) / 2:.0f}" y="{Y0 + 42}" text-anchor="middle">compaction threshold (tokens in the conversation)</text>')

# The default threshold, as a reference line.
out.append(f'<line class="axis" x1="{x(300):.1f}" x2="{x(300):.1f}" y1="{Y1 - 6}" y2="{Y0}" stroke-width="1" stroke-dasharray="3 4"/>')
out.append(f'<text class="muted" x="{x(300) + 6:.1f}" y="{Y1 + 4}">default (300 k)</text>')

for name, cls, vals in SERIES:
    pts = ' '.join(f'{x(t):.1f},{y(v):.1f}' for t, v in zip(T, vals))
    out.append(f'<polyline class="l{cls}" points="{pts}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>')
for name, cls, vals in SERIES:
    for t, v in zip(T, vals):
        # A surface-coloured ring, then the marker: overlapping points stay apart.
        out.append(f'<circle class="bg" cx="{x(t):.1f}" cy="{y(v):.1f}" r="6"/>')
        out.append(f'<circle class="d{cls}" cx="{x(t):.1f}" cy="{y(v):.1f}" r="4"/>')
# Direct labels at the lines' ends, pushed apart so they never overlap.
ends = sorted(((y(vals[-1]), name, vals[-1]) for name, cls, vals in SERIES))
placed = []
for yy, name, v in ends:
    yy = max(yy, placed[-1] + 17) if placed else yy
    placed.append(yy)
    out.append(f'<text class="ink" x="{x(400) + 12:.1f}" y="{yy + 4:.1f}">{name} · {v:.1f} %</text>')

out.append('</svg>')
Path(__file__).with_name('savings.svg').write_text('\n'.join(out) + '\n', encoding='utf8')
print('savings.svg written')

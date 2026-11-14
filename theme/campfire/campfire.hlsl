// "Campfire": an animated background for Windows Terminal (the Seuil theme).
// A night landscape across the whole width: starry sky, mountains, forest, and a camp on the right
// (tent, fire, cat). Sky, stars, mountains and forest are computed here, so they hold at any width;
// the camp comes from campfire.png (painted by paint.mjs), in register t1.
// The ground line sits above Claude Code's prompt area: nothing ever passes under the line you type in.
// The tones stay dark, close to the background; text is always drawn on top.
Texture2D shaderTexture;
Texture2D image : register(t1);
SamplerState samplerState;

cbuffer PixelShaderSettings {
  float  Time;
  float  Scale;
  float2 Resolution;
  float4 Background;
};

// The same numbers as in paint.mjs.
static const int W = 200;
static const int H = 80;
static const float GY = 71.0;
static const int CAT_Y = 160;
static const float2 CAT_POS = float2(34.0, 52.0);
static const float2 FIRE = float2(78.0, 69.0);
// The camp stops MARGIN pixels from the right edge.
static const float MARGIN = 12.0;
// The background colour of the "Seuil Campfire" colour scheme (#08080A, nearly black).
static const float3 BACKGROUND = float3(8.0, 8.0, 10.0) / 255.0;
// How present the scenery is: 0 = invisible, 1 = full colours. It stays in the back so reading is never hindered.
static const float PRESENCE = 0.50;
// The camp (fire, cat, tent) keeps a little more presence than the landscape.
static const float PRESENCE_CAMP = 0.72;
// Claude Code's prompt area, at the bottom: rows left free under the ground, and the height of one row
// (12 pt font, before scaling).
static const float PROMPT_ROWS = 6.0;
static const float ROW_HEIGHT = 18.6;

float hash(float2 p) { p = frac(p * float2(123.34, 456.21)); p += dot(p, p + 45.32); return frac(p.x * p.y); }
float noise(float2 p) {
  float2 i = floor(p), f = frac(p);
  f = f * f * (3.0 - 2.0 * f);
  return lerp(lerp(hash(i), hash(i + float2(1, 0)), f.x), lerp(hash(i + float2(0, 1)), hash(i + float2(1, 1)), f.x), f.y);
}
float tri(float u) { return 1.0 - abs(2.0 * frac(u) - 1.0); }
bool empty(float3 c) { return c.r > 0.85 && c.g < 0.2 && c.b > 0.85; }
float dither(float2 q) {
  float2 m = fmod(q + 4096.0, 4.0);
  float v = fmod(m.x * 5.0 + m.y * 3.0 + floor(m.x * 0.5) * 2.0 + floor(m.y * 0.5) * 8.0, 16.0);
  return (v + 0.5) / 16.0;
}
float3 rgb(float r, float v, float b) { return float3(r, v, b) / 255.0; }

// Height of a row of distant firs: tight triangles of uneven sizes.
float firRow(float x, float step_, float low, float high, float seed) {
  float c = floor(x / step_), top = low * 0.45;
  for (int i = -1; i <= 1; i++) {
    float cc = c + i;
    float center = floor((cc + 0.5) * step_ + (hash(float2(cc, seed)) - 0.5) * step_ * 0.6);
    float h = low + (high - low) * hash(float2(cc, seed + 1.0));
    top = max(top, h - floor(abs(x - center)) * 2.3);
  }
  return top;
}
// Brightness of a star in this cell (0 when there is none).
float star(float2 q, float rarity, float t) {
  float h = hash(q);
  if (h < rarity) return 0.0;
  float bright = 0.30 + 0.70 * hash(q + 7.3);
  return bright * (0.55 + 0.45 * sin(t * (0.5 + 2.4 * hash(q + 1.7)) + 6.28 * hash(q + 3.1)));
}

// The landscape at pixel q (camp coordinates: x to the right, y downwards, ground at GY).
// celestial = 1 for a star or the moon: they fade out near text.
float3 scene(float2 q, float t, out float celestial) {
  float x = q.x, alt = GY - 1.0 - q.y;
  float3 col = BACKGROUND;
  celestial = 0.0;
  // Everything that burns moves at 12 frames per second, like hand-drawn animation.
  float tf = floor(t * 12.0) / 12.0;
  float breath = noise(float2(tf * 2.6, 3.7));

  if (alt >= 0.0) {
    // Sky: it barely lightens towards the horizon, in dithered steps.
    float low = saturate(1.0 - alt / 130.0);
    col = lerp(BACKGROUND, rgb(15, 21, 36), floor(low * low * 6.0 + dither(q)) / 7.0);

    float mount = 44.0 + 30.0 * tri(x / 210.0 + 0.12) + 15.0 * tri(x / 87.0 + 0.6) + 5.0 * tri(x / 37.0 + 0.3) - 1.6 * hash(float2(floor(x / 2.0), 11.0));
    float hill = 30.0 + 14.0 * tri(x / 150.0 + 0.55) + 8.0 * tri(x / 61.0 + 0.2) + 3.0 * tri(x / 23.0 + 0.7);
    float far = 6.0 + firRow(x, 7.0, 10.0, 19.0, 3.0);
    float near = firRow(x + 40.0, 11.0, 15.0, 29.0, 8.0);

    if (alt < near) col = alt > near - 1.5 ? rgb(10, 15, 20) : rgb(6, 8, 11);
    else if (alt < far) col = rgb(10, 15, 24);
    else if (alt < hill) col = alt > hill - 1.5 ? rgb(19, 28, 44) : rgb(14, 21, 34);
    else if (alt < mount) {
      // Mountains: ridge and snowy peaks one tone up, the left slope in shadow.
      float below = mount - alt;
      float snow = (mount - 66.0) * 0.55 - 2.0 * hash(float2(floor(x / 3.0), 5.0));
      // The shadow line runs down from each peak at a slant, as on a real ridge.
      float xo = x + below * 0.7;
      bool shade = 30.0 * tri((xo + 2.0) / 210.0 + 0.12) + 15.0 * tri((xo + 2.0) / 87.0 + 0.6) > 30.0 * tri((xo - 2.0) / 210.0 + 0.12) + 15.0 * tri((xo - 2.0) / 87.0 + 0.6);
      col = below < snow ? (shade ? rgb(36, 49, 74) : rgb(50, 66, 94)) : (below < 1.5 ? rgb(30, 42, 66) : (shade ? rgb(19, 29, 47) : rgb(24, 36, 57)));
    } else {
      // Stars: rarer towards the horizon; the biggest light up their four neighbours.
      float rarity = 0.9962 + 0.0030 * saturate(1.0 - alt / 150.0);
      float3 white = float3(0.74, 0.83, 1.0);
      float e = star(q, rarity, t) * 0.75;
      float crossGlow = star(q + float2(1, 0), 0.99965, t) + star(q - float2(1, 0), 0.99965, t) + star(q + float2(0, 1), 0.99965, t) + star(q - float2(0, 1), 0.99965, t);
      e += crossGlow * 0.28;

      // A shooting star, now and then.
      float round_ = floor(t / 23.0), phase = t - round_ * 23.0;
      float2 dir = normalize(float2(-1.0, 0.42));
      float2 head = float2(-60.0 - 260.0 * hash(float2(round_, 1.0)), -150.0 - 60.0 * hash(float2(round_, 2.0))) + dir * phase * 130.0;
      float2 rel = q - head;
      float behind = dot(rel, -dir), across = abs(rel.x * dir.y - rel.y * dir.x);
      if (phase < 0.8 && behind >= 0.0 && behind < 16.0 && across < 0.7) e += (1.0 - behind / 16.0) * 0.9;

      // A small crescent moon, with a barely visible halo.
      float2 moon = q - float2(44.0, -118.0);
      float dl = length(moon);
      if (dl < 6.5 && length(moon - float2(-3.0, -2.0)) > 5.6) { col = rgb(226, 224, 204); celestial = 1.0; e = 0.0; }
      else if (dl < 22.0) col += float3(0.5, 0.6, 0.8) * floor((1.0 - dl / 22.0) * 4.0 + dither(q)) / 4.0 * 0.045;

      if (e > 0.02) { col += white * e; celestial = 1.0; }
    }
  } else {
    // The ground outside the camp: grass, then soil that frays into the background colour.
    float d = -alt - 1.0;
    if (d < 0.5) col = rgb(28, 44, 48);
    else if (d < 2.5) col = rgb(20, 31, 38);
    else if (d < 9.0 && dither(q) >= (d - 2.0) / 7.0) col = rgb(13, 14, 18);
  }

  // Firelight on the night and the forest behind: a few faint dithered rings.
  float2 e2 = (q - (FIRE + float2(0.0, -5.0))) * float2(1.0, 1.25);
  float halo = saturate(1.0 - length(e2) / (40.0 + 4.0 * breath));
  col += float3(1.0, 0.50, 0.18) * floor(halo * halo * 5.0 + dither(q) * 0.9) / 5.0 * 0.10;

  // Smoke: three puffs that rise and dissolve in dither.
  for (int i = 0; i < 3; i++) {
    float age = frac(t * 0.07 + i * 0.3333);
    float2 center = FIRE + float2(round(sin(age * 4.0 + i * 2.1) * 3.0 + age * 6.0), -round(20.0 + age * 26.0));
    if (length(q - center) < 1.5 + age * 3.0 && dither(q) < (1.0 - age) * 0.55) col = lerp(col, float3(0.24, 0.27, 0.34), 0.5 * (1.0 - age));
  }

  // The painted camp.
  if (q.x >= 0.0 && q.x < W && q.y >= 0.0 && q.y < H) {
    float3 scenery = image.Load(int3((int)q.x, (int)q.y, 0)).rgb;
    float3 mask = image.Load(int3((int)q.x, (int)q.y + H, 0)).rgb;
    if (!empty(scenery)) {
      // What the fire lights dims and brightens with it; embers and the lamp glow.
      col = scenery * (1.0 - mask.r * 0.30 * (1.0 - breath));
      col *= 1.0 - mask.b * 0.35 * noise(float2(q.x * 0.7 + tf * 1.3, q.y * 0.7 - tf * 2.1));
      celestial = 0.0;
    }
  }

  // Fireflies, left of the camp.
  for (int k = 0; k < 5; k++) {
    float2 base = float2(-70.0 + 26.0 * k + 30.0 * hash(float2(k, 5.0)), GY - 8.0 - 16.0 * hash(float2(k, 9.0)));
    float2 here = round(base + float2(sin(t * 0.4 + k * 1.9) * 7.0, cos(t * 0.31 + k * 2.7) * 4.0));
    float glow = saturate(sin(t * 1.1 + k * 2.3) * 2.0);
    float dd = abs(q.x - here.x) + abs(q.y - here.y);
    if (dd < 0.5) col = lerp(col, float3(0.80, 0.95, 0.45), glow);
    else if (dd < 1.5) col += float3(0.45, 0.62, 0.18) * 0.22 * glow;
  }

  // The cat: sits for 32 s (its tail swishes at times, it blinks), then sleeps for 18 s.
  float2 l = q - CAT_POS;
  float cycle = fmod(t, 50.0);
  if (l.x >= 0.0 && l.x < 22.0 && l.y >= 0.0 && l.y < 20.0) {
    int f = 0;
    if (cycle < 32.0) {
      float step_ = fmod(floor(t * 4.0), 4.0);
      if (frac(t / 7.0) < 0.45) f = step_ < 0.5 ? 0 : (step_ < 1.5 ? 1 : (step_ < 2.5 ? 2 : 1));
      else if (frac(t / 4.3) < 0.035) f = 3;
    } else {
      f = frac(t / 3.2) < 0.5 ? 4 : 5;
    }
    float3 cat = image.Load(int3(f * 22 + (int)l.x, CAT_Y + (int)l.y, 0)).rgb;
    if (!empty(cat)) col = cat * (0.90 + 0.10 * breath);
  }
  // While it sleeps: a little "z" floating up.
  if (cycle >= 33.0) {
    float m = frac(t / 2.6);
    float2 z = q - (CAT_POS + float2(3.0 - round(m * 4.0), 4.0 - round(m * 9.0)));
    bool stroke = z.x >= 0.0 && z.x < 3.0 && z.y >= 0.0 && z.y < 3.0 && (z.y < 0.5 || z.y > 1.5 || (z.x > 0.5 && z.x < 1.5));
    if (stroke && dither(q) < 1.0 - m) col = float3(0.62, 0.72, 0.90);
  }

  // The flames: a tongue that tapers, leans and tears, in four plain tints.
  float2 r = q - FIRE;
  float v = -r.y;
  if (v >= -1.0 && v < 24.0 && abs(r.x) < 11.0) {
    float h = saturate(v / 21.0);
    float lean = (sin(tf * 2.3 + v * 0.24) * 1.5 + sin(tf * 3.7 + 1.3) * 0.9) * h;
    float width = lerp(6.6, 0.9, pow(h, 0.75));
    float d = abs(r.x - lean) / width;
    float n1 = noise(float2(r.x * 0.36, v * 0.27 - tf * 5.5));
    float n2 = noise(float2(r.x * 0.85 + 9.0, v * 0.60 - tf * 9.0));
    float heat = (1.0 - d) * (1.18 - h) + (n1 - 0.5) * 0.80 + (n2 - 0.5) * 0.28 + (breath - 0.5) * 0.12;
    if (heat > 0.66) col = float3(1.00, 0.95, 0.72);
    else if (heat > 0.46) col = float3(1.00, 0.80, 0.34);
    else if (heat > 0.27) col = float3(0.96, 0.53, 0.17);
    else if (heat > 0.12) col = float3(0.76, 0.26, 0.12);
    else if (heat > 0.05 && dither(q) < 0.5) col = float3(0.45, 0.13, 0.10);
  }

  // Sparks: a pixel that zigzags up and goes out.
  for (int n = 0; n < 5; n++) {
    float speed = 0.22 + 0.05 * hash(float2(n, 1.0));
    float age = frac(t * speed + hash(float2(n, 2.0)));
    float round_ = floor(t * speed + hash(float2(n, 2.0)));
    float2 here = FIRE + float2(round((hash(float2(n, round_)) - 0.5) * 9.0 + sin(age * 7.0 + n) * 2.5 * age), -round(9.0 + age * 30.0));
    if (q.x == here.x && q.y == here.y && dither(q + n) < 1.15 - age) col = lerp(float3(1.0, 0.86, 0.45), float3(0.85, 0.30, 0.12), age);
  }

  return col;
}

// What the terminal drew here, background removed: premultiplied rgb and coverage (0 = bare background, 1 = full).
// The background arrives transparent; if it ever arrived opaque, in the background colour, it is treated the same.
float4 stroke(float2 uv) {
  float4 b = shaderTexture.SampleLevel(samplerState, uv, 0);
  float bare = step(0.995, b.a) * (1.0 - smoothstep(0.02, 0.10, distance(b.rgb, BACKGROUND)));
  return b * (1.0 - bare);
}

float4 main(float4 pos : SV_POSITION, float2 tex : TEXCOORD) : SV_TARGET {
  float4 drawn = stroke(tex);
  float2 px = tex * Resolution;
  // One scenery pixel = a whole number of screen pixels.
  float g = clamp(floor(Resolution.y / 400.0 + 0.5), 2.0, 5.0);
  // The ground line, above the prompt area.
  float groundY = Resolution.y - (12.0 + PROMPT_ROWS * ROW_HEIGHT) * Scale;
  float2 q = float2(W + MARGIN + floor((px.x - Resolution.x) / g), GY - 1.0 - floor((groundY - px.y) / g));

  float celestial;
  float3 s = scene(q, Time, celestial);
  // The scenery stays in the back: faded towards the background black, the camp a little less than the rest.
  float camp = saturate(1.0 - length((q - (FIRE + float2(20.0, -12.0))) * float2(1.0, 1.6)) / 110.0);
  s = lerp(BACKGROUND, s, lerp(PRESENCE, PRESENCE_CAMP, smoothstep(0.0, 0.5, camp)));

  // The terminal's padding is not drawn by the shader: the scenery fades into it.
  float edge = min(min(px.x, Resolution.x - px.x), px.y);
  s = lerp(BACKGROUND, s, smoothstep(0.0, 16.0 * Scale, edge));

  // Near text, whatever is bright fades (stars, moon, fire, tent canvas): it reads as on a plain background.
  float luma = dot(s, float3(0.30, 0.59, 0.11));
  if (celestial > 0.5 || luma > 0.12) {
    float around = drawn.a;
    float radius = 10.0 * Scale;
    static const float2 TAPS[8] = { float2(1, 0), float2(-1, 0), float2(0, 1), float2(0, -1), float2(0.7, 0.7), float2(-0.7, 0.7), float2(0.7, -0.7), float2(-0.7, -0.7) };
    for (int i = 0; i < 8; i++) around += stroke(tex + TAPS[i] * radius / Resolution).a;
    float fade = saturate(around / 2.0);
    s = lerp(s, lerp(BACKGROUND, s, celestial > 0.5 ? 0.0 : 0.22), fade);
  }

  // Text on top, with its own coverage: crisp edges, no fringe.
  return float4(drawn.rgb + s * (1.0 - drawn.a), 1.0);
}

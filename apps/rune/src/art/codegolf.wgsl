struct Uniforms { rect: vec4<f32>, surface: vec4<f32>, clock: vec4<f32>, color: vec4<f32> }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> points: array<vec2<f32>>;
struct Out { @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32>, @location(1) @interpolate(flat) side: f32 }
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Out {
    let corners = array<vec2<f32>, 6>(vec2(0.,0.), vec2(1.,0.), vec2(0.,1.), vec2(0.,1.), vec2(1.,0.), vec2(1.,1.));
    let i = 9999u - instance;
    let yv = points[i].x;
    let t = u.clock.x;
    let k = points[i].y * cos(f32(i) + t / 4.);
    let e = yv / 3. - 13.;
    let parity = f32(i % 2u);
    let d = length(vec2(k,e)) + cos(e + t * 2. + parity * 4.);
    let q = yv * k / 5. * (2. + sin(d * 2. + yv - t * 4.)) + 80.;
    let c = d / 4. - t / 2. + parity * 3.;
    let wh = u.rect.zw / u.clock.y;
    let fit = clamp(min(wh.x, wh.y) / 520., 0.38, 1.55);
    let dot_size = max(0.75, 1.5 * fit);
    let max_extent = 2.3 * fit * 1.12;
    let max_xy = wh * 0.42 - vec2(dot_size);
    let spread = min(1., min(max_xy.x / (122. * max_extent), max_xy.y / (285. * max_extent)));
    let size = max_extent * spread;
    let pan_max = max(vec2(0.), max_xy - vec2(122., 285.) * size * 0.9);
    let pan = vec2(sin(t * 0.15), cos(t * 0.1)) * min(vec2(60.,40.) * fit, pan_max);
    let a = t * 0.05;
    let fringe = 0.5 * (abs(cos(a)) + abs(sin(a)));
    let pos = (vec2(q * cos(c), q * sin(c) + d * 9. - 180.) - u.clock.zw) * size + (corners[vertex] * (dot_size + 2.0 * fringe / u.clock.y) - vec2(fringe / u.clock.y));
    let rotated = vec2(cos(a) * pos.x - sin(a) * pos.y, sin(a) * pos.x + cos(a) * pos.y);
    let pixel = u.rect.xy + (wh * 0.5 + pan + rotated) * u.clock.y - u.surface.zw;
    var out: Out;
    out.position = vec4(pixel.x / u.surface.x * 2. - 1., 1. - pixel.y / u.surface.y * 2., 0., 1.);
    out.local = corners[vertex] * (dot_size * u.clock.y + 2.0 * fringe) - vec2(fringe);
    out.side = dot_size * u.clock.y;
    return out;
}
fn linear(c: vec3<f32>) -> vec3<f32> { return select(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), c > vec3(0.04045)); }
@fragment fn fs(input: Out) -> @location(0) vec4<f32> {
    let color = select(linear(u.color.rgb), u.color.rgb, u.color.a >= 0.0);
    // Integrate the rotated fillRect over this device pixel, as Canvas2D does.
    // The pixel square is transformed into rectangle-local coordinates, clipped
    // against the four rectangle edges, then measured by the shoelace formula.
    let a = u.clock.x * 0.05;
    let dx = vec2(cos(a), -sin(a)) * 0.5;
    let dy = vec2(sin(a), cos(a)) * 0.5;
    var polygon: array<vec2<f32>, 12>;
    polygon[0] = input.local - dx - dy;
    polygon[1] = input.local + dx - dy;
    polygon[2] = input.local + dx + dy;
    polygon[3] = input.local - dx + dy;
    var count = 4u;
    for (var edge = 0u; edge < 4u; edge++) {
        var clipped: array<vec2<f32>, 12>;
        var n = 0u;
        let axis = edge / 2u;
        let limit = select(0.0, input.side, edge % 2u == 1u);
        for (var i = 0u; i < count; i++) {
            let p = polygon[i];
            let q = polygon[(i + 1u) % count];
            let inside_p = select(p[axis] >= limit, p[axis] <= limit, edge % 2u == 1u);
            let inside_q = select(q[axis] >= limit, q[axis] <= limit, edge % 2u == 1u);
            if inside_p { clipped[n] = p; n++; }
            if inside_p != inside_q {
                clipped[n] = mix(p, q, (limit - p[axis]) / (q[axis] - p[axis]));
                n++;
            }
        }
        polygon = clipped;
        count = n;
    }
    var area = 0.0;
    for (var i = 0u; i < count; i++) {
        let p = polygon[i];
        let q = polygon[(i + 1u) % count];
        area += p.x * q.y - p.y * q.x;
    }
    let coverage = clamp(abs(area) * 0.5, 0.0, 1.0);
    let alpha = abs(u.color.a) * 0.15 * coverage;
    // Canvas2D stores each premultiplied draw in its 8-bit backing store
    // before the lighter operation. Preserve that quantization even when
    // Rune composites through a floating-point intermediate.
    return floor(vec4(color * alpha, alpha) * 255.0 + vec4(0.5)) / 255.0;
}

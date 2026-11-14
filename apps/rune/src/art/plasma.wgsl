struct Uniforms { rect: vec4<f32>, surface: vec4<f32>, clock: vec4<f32>, style: vec4<f32> }
@group(0) @binding(0) var<uniform> u: Uniforms;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let positions = array<vec2<f32>,3>(vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
    return vec4(positions[i],0.0,1.0);
}
fn mod289(x: vec3<f32>) -> vec3<f32> { return x-floor(x/289.0)*289.0; }
fn permute(x: vec3<f32>) -> vec3<f32> { return mod289(((x*34.0)+1.0)*x); }
fn linear(c: vec3<f32>) -> vec3<f32> { return select(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),c>vec3(0.04045)); }
fn snoise(v: vec2<f32>) -> f32 {
    let c = vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
    var i = floor(v+dot(v,c.yy)); let x0=v-i+dot(i,c.xx);
    let i1=select(vec2(0.0,1.0),vec2(1.0,0.0),x0.x>x0.y);
    var x12=x0.xyxy+c.xxzz; x12=vec4(x12.xy-i1,x12.zw);
    i=i-floor(i/289.0)*289.0;
    let p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
    var m=max(vec3(0.5)-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),vec3(0.0));
    m=m*m; m=m*m;
    let x2=2.0*fract(p*c.www)-1.0; let h=abs(x2)-0.5;
    let ox=floor(x2+0.5); let a0=x2-ox;
    m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
    let g=vec3(a0.x*x0.x+h.x*x0.y,a0.y*x12.x+h.y*x12.y,a0.z*x12.z+h.z*x12.w);
    return 130.0*dot(m,g);
}
fn fbm(input: vec2<f32>) -> f32 {
    var p=input; var total: f32=0.0; var amp: f32=0.5; var freq: f32=1.0;
    let rotation=mat2x2<f32>(cos(0.45),sin(0.45),-sin(0.45),cos(0.45));
    for(var i=0;i<5;i++) { total+=snoise(p*freq)*amp; p=rotation*p; freq*=2.0625; amp*=0.5; }
    return total;
}
@fragment fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pixel=position.xy+u.surface.zw-u.rect.xy;
    if any(pixel<vec2(0.0)) || any(pixel>u.rect.zw) { discard; }
    let frag=vec2(pixel.x,u.rect.w-pixel.y);
    let uv=frag/u.rect.zw; let aspect=u.rect.z/max(u.rect.w,1.0);
    var p=(uv-0.5)*vec2(aspect,1.0);
    // ClosingPlasma's pointer starts at the centre even in its non-interactive
    // backdrop scenes, so retain its subtle inward warp around that point.
    let d_mouse=length(p);
    p*=1.0-0.02*(1.0-smoothstep(0.0,0.45,d_mouse));
    let t=u.clock.x*(0.15*0.55); let dark=u.clock.y;
    let flow=vec2(fbm(p+vec2(t*0.2,t*0.1)),fbm(p+vec2(-t*0.1,t*0.3)));
    let n=fbm(p*2.0+flow*1.45);
    let ridges=pow(1.0-abs(snoise(p*4.0+n)*2.0),3.0);
    let a=mix(vec3(246.0,245.0,243.0)/255.0,vec3(7.0,7.0,8.0)/255.0,dark);
    let b=mix(vec3(239.0,228.0,220.0)/255.0,vec3(18.0,13.0,10.0)/255.0,dark);
    let c=mix(vec3(228.0,193.0,175.0)/255.0,vec3(67.0,37.0,26.0)/255.0,dark);
    var color=mix(a,b,smoothstep(-0.5,0.5,n));
    color=mix(color,c,smoothstep(0.25,1.0,n*0.52+ridges*0.48));
    // ClosingPlasma caps its canvas at 1.75 device pixels per CSS pixel, so
    // match that absolute-coordinate density for grain and sparkle while
    // leaving the normalized noise field alone.
    let source_frag=frag*(1.75/max(u.style.x,1.0));
    let sparkle=pow(max(0.0,snoise(source_frag*0.2+t*2.0)),18.0)*0.5*0.35;
    color+=mix(vec3(0.56,0.58,0.72),vec3(0.8,0.9,1.0),dark)*sparkle;
    let vig_dark=1.0-smoothstep(0.5,mix(1.8,1.55,dark),length(p));
    color=mix(color,color*vig_dark,dark);
    let vig_light=1.0-smoothstep(0.4,1.45,length(p));
    color=mix(mix(vec3(1.0),color,vig_light),color,dark);
    let grain=(fract(sin(dot(source_frag+t*50.0,vec2(12.9898,78.233)))*43758.5453)-0.5)*(0.06*0.4);
    color=clamp(color+grain,vec3(0.0),vec3(1.0));
    if u.clock.z<0.5 { color=linear(color); }
    // Match WebGL's premultiplied canvas: CSS opacity affects both colour and alpha.
    let mask=clamp((1.0-uv.y)/0.55,0.0,1.0)*u.clock.w;
    let alpha=mask*mix(1.0,0.5,dark);
    return vec4(color*alpha,alpha);
}

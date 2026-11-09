use std::collections::HashMap;
use rune::compose::{Compositor, DeviceKey, Frame};
use crate::state::AppState;

#[derive(Default)]
pub struct Plasma {
    device: Option<DeviceKey>,
    pipelines: HashMap<wgpu::TextureFormat, Pipeline>,
}
struct Pipeline { pipeline: wgpu::RenderPipeline, buffer: wgpu::Buffer, bind: wgpu::BindGroup }
impl Pipeline {
    fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let module=device.create_shader_module(wgpu::ShaderModuleDescriptor { label:Some("home-plasma"), source:wgpu::ShaderSource::Wgsl(include_str!("art/plasma.wgsl").into()) });
        let bgl=device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label:Some("plasma"),entries:&[wgpu::BindGroupLayoutEntry { binding:0, visibility:wgpu::ShaderStages::FRAGMENT,ty:wgpu::BindingType::Buffer { ty:wgpu::BufferBindingType::Uniform,has_dynamic_offset:false,min_binding_size:None },count:None }] });
        let buffer=device.create_buffer(&wgpu::BufferDescriptor { label:Some("plasma"),size:48,usage:wgpu::BufferUsages::UNIFORM|wgpu::BufferUsages::COPY_DST,mapped_at_creation:false });
        let bind=device.create_bind_group(&wgpu::BindGroupDescriptor { label:Some("plasma"),layout:&bgl,entries:&[wgpu::BindGroupEntry { binding:0,resource:buffer.as_entire_binding() }] });
        let layout=device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label:Some("plasma"),bind_group_layouts:&[Some(&bgl)],immediate_size:0 });
        let pipeline=device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label:Some("home-plasma"),layout:Some(&layout),vertex:wgpu::VertexState { module:&module,entry_point:Some("vs"),compilation_options:Default::default(),buffers:&[] },
            primitive:Default::default(),depth_stencil:None,multisample:Default::default(),
            fragment:Some(wgpu::FragmentState { module:&module,entry_point:Some("fs"),compilation_options:Default::default(),targets:&[Some(wgpu::ColorTargetState { format,blend:Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),write_mask:wgpu::ColorWrites::ALL })] }),multiview_mask:None,cache:None,
        });
        Self { pipeline,buffer,bind }
    }
}
impl Compositor<AppState> for Plasma {
    fn render(&mut self, f: &mut Frame<'_,AppState>) {
        let key=f.device_key();
        if self.device!=Some(key) { self.pipelines.clear(); self.device=Some(key); }
        let clear=f.rt.clear_color(); let time=f.rt.t as f32;
        let (device,queue)=(f.device,f.queue);
        f.ui.prepare(device,queue,&mut f.rt.text.atlas,&f.rt.instances,f.size);
        f.ui.draw_with(f.encoder,f.target,clear,&mut |pass,site| {
            if site.mark!=0x504c { return; }
            let pipeline=self.pipelines.entry(site.format).or_insert_with(|| Pipeline::new(device,site.format));
            let mut values=Vec::with_capacity(48);
            for value in site.instance.rect.into_iter().chain([site.size[0] as f32,site.size[1] as f32,site.origin[0],site.origin[1],time,site.data[0],if site.srgb_blend {1.0}else{0.0},0.0]) { values.extend_from_slice(&value.to_ne_bytes()); }
            queue.write_buffer(&pipeline.buffer,0,&values);
            pass.set_pipeline(&pipeline.pipeline); pass.set_bind_group(0,&pipeline.bind,&[]); pass.draw(0..3,0..1);
        });
    }
}

pub fn slot(s: &AppState, cx: &rune::Cx<AppState>) -> rune::El {
    let height = cx.layout_size("empty-root").map_or(352.8, |size| (size[1] * 0.42).clamp(220.0, 380.0));
    let art = rune::effect(0x504c)
        .effect_data([if cx.system_dark() { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0])
        .h(height).pin(Some(0.0), None, Some(0.0), Some(0.0));
    if s.art_focused {
        // The shader changes its pixels; this clock only schedules bounded GPU frames.
        art.cycle(rune::Cycle { period: 1.0, phase: 0.0, stops: &[(0.0, 1.0), (1.0, 1.0)], still: 1.0, fps: 20.0 })
    } else { art }
}

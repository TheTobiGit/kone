use rune::compose::DeviceKey;
use rune::render::EffectSite;
use std::collections::HashMap;

/// Each simultaneous slot must use a distinct mark. Reserve this range for code golf slots.
pub const MARK_BASE: u32 = 0x4347_0000;

#[derive(Default)]
pub struct CodeGolf {
    device: Option<DeviceKey>,
    pipelines: HashMap<(u32, wgpu::TextureFormat), Pipeline>,
    times: HashMap<u32, f32>,
    dt: f32,
}

struct Pipeline {
    pipeline: wgpu::RenderPipeline,
    uniform: wgpu::Buffer,
    bind: wgpu::BindGroup,
}

fn points() -> (Vec<u8>, [f32; 2]) {
    let mut bytes = Vec::with_capacity(10000 * 8);
    let mut sum = [0.0_f64; 2];
    for i in 0..10000 {
        let y = f64::from(i) / 790.0;
        let part = if y < 8.0 {
            9.0 + y.powi(9).sin() * 6.0
        } else {
            4.0 + y.cos()
        };
        let k = part * f64::from(i).cos();
        let e = y / 3.0 - 13.0;
        let d = k.hypot(e) + (e + f64::from(i % 2) * 4.0).cos();
        let q = y * k / 5.0 * (2.0 + (d * 2.0 + y).sin()) + 80.0;
        let c = d / 4.0 + f64::from(i % 2) * 3.0;
        sum[0] += q * c.cos();
        sum[1] += q * c.sin() + d * 9.0 - 180.0;
        bytes.extend_from_slice(&(y as f32).to_ne_bytes());
        bytes.extend_from_slice(&(part as f32).to_ne_bytes());
    }
    (
        bytes,
        [(sum[0] / 10000.0) as f32, (sum[1] / 10000.0) as f32],
    )
}

impl Pipeline {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("codegolf"),
            source: wgpu::ShaderSource::Wgsl(include_str!("codegolf.wgsl").into()),
        });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("codegolf"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("codegolf-uniform"),
            size: 64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let (data, _) = points();
        let point_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("codegolf-points"),
            size: data.len() as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&point_buffer, 0, &data);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("codegolf"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: point_buffer.as_entire_binding(),
                },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("codegolf"),
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });
        let add = wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        };
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("codegolf"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState {
                        color: add,
                        alpha: add,
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        Self {
            pipeline,
            uniform,
            bind,
        }
    }
}

impl CodeGolf {
    /// Call once per frame, before `draw_with`. Freeze the clock when the artwork is hidden or unfocused.
    pub fn begin_frame(&mut self, device: DeviceKey, dt: f64, active: bool) {
        if self.device != Some(device) {
            self.device = Some(device);
            self.pipelines.clear();
        }
        self.dt = if active {
            dt.min(0.1) as f32 * 1.2
        } else {
            0.0
        };
    }
    /// Call for matching effect marks inside Rune's `draw_with` hook.
    pub fn draw(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pass: &mut wgpu::RenderPass<'_>,
        site: &EffectSite<'_>,
    ) {
        let time = self.times.entry(site.mark).or_default();
        if site.data[3] >= 0.0 {
            *time += self.dt;
        }
        // Scene captures use the requested virtual instant, independent of the
        // number of preparation frames the snapshot renderer needs.
        let time = *CAPTURE_TIME
            .get_or_init(|| {
                let args: Vec<_> = std::env::args().collect();
                std::env::var("KONE_CAPTURE_ART_TIME")
                    .ok()
                    .and_then(|time| time.parse().ok())
                    .or_else(|| {
                        args.windows(2)
                            .find(|pair| pair[0] == "--at")
                            .and_then(|pair| pair[1].parse::<f32>().ok())
                    })
            })
            .as_ref()
            .unwrap_or(time);
        let pipe = self
            .pipelines
            .entry((site.mark, site.format))
            .or_insert_with(|| Pipeline::new(device, queue, site.format));
        let centroid = *CENTROID.get_or_init(|| points().1);
        let values = [
            site.instance.rect[0],
            site.instance.rect[1],
            site.instance.rect[2],
            site.instance.rect[3],
            site.size[0] as f32,
            site.size[1] as f32,
            site.origin[0],
            site.origin[1],
            time,
            site.scale,
            centroid[0],
            centroid[1],
            site.data[0],
            site.data[1],
            site.data[2],
            if site.srgb_blend {
                site.data[3].abs()
            } else {
                -site.data[3].abs()
            },
        ];
        let mut bytes = [0u8; 64];
        for (chunk, value) in bytes.as_chunks_mut::<4>().0.iter_mut().zip(values) {
            *chunk = value.to_ne_bytes();
        }
        queue.write_buffer(&pipe.uniform, 0, &bytes);
        pass.set_pipeline(&pipe.pipeline);
        pass.set_bind_group(0, &pipe.bind, &[]);
        pass.draw(0..6, 0..10000);
    }
}
static CAPTURE_TIME: std::sync::OnceLock<Option<f32>> = std::sync::OnceLock::new();
static CENTROID: std::sync::OnceLock<[f32; 2]> = std::sync::OnceLock::new();

/// `color` is the CSS sRGB accent; its alpha is the completed canvas opacity.
pub fn slot(mark: u32, focused_and_visible: bool, color: [f32; 4]) -> rune::El {
    let opacity = color[3].abs();
    let mut color = [color[0], color[1], color[2], 1.0];
    if !focused_and_visible {
        color[3] = -color[3];
    }
    let art = rune::effect(mark).effect_data(color).w_full().h_full();
    let art = if focused_and_visible {
        art.cycle(rune::Cycle {
            period: 1.0,
            phase: 0.0,
            stops: &[(0.0, 1.0), (1.0, 1.0)],
            still: 1.0,
            fps: 20.0,
        })
    } else {
        art
    };
    rune::el()
        .w_full()
        .h_full()
        .opacity(opacity)
        .child(rune::el().w_full().h_full().additive_canvas().child(art))
}

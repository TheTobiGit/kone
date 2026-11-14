#!/usr/bin/env python3
"""Capture Rune scenes serially; each renderer gets its own timeout."""
import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
parser = argparse.ArgumentParser()
parser.add_argument('outdir', type=Path)
parser.add_argument('--scenes', required=True, help='comma-separated Rune scene names; empty-brand-hover is supported')
parser.add_argument('--binary', type=Path, default=ROOT / 'target/debug/kone-rune')
parser.add_argument('--timeout', type=int, default=180)
parser.add_argument('--scale', type=int, default=1)
parser.add_argument('--size', default='1292x854', help='window size in points')
parser.add_argument('--script', type=Path, help='input events for every capture')
parser.add_argument('--at', type=float, help='capture time in seconds')
args = parser.parse_args()
scenes = args.scenes.split(',')
if any(not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', s) for s in scenes):
    parser.error('invalid scene name')
available = set(re.findall(r'\(\s*"([a-z0-9-]+)"\s*,', (ROOT / 'apps/rune/src/main.rs').read_text()))
unknown = [s for s in scenes if s not in available and s != 'empty-brand-hover']
if unknown:
    parser.error('unknown Rune scenes: ' + ', '.join(unknown))
args.outdir.mkdir(parents=True, exist_ok=True)
for scene in scenes:
    hover = scene == 'empty-brand-hover'
    native_scene = 'empty-brand' if hover else scene
    if scene == 'studio-overview-mid':
        native_scene = 'studio-three-review'
    for theme in ('light', 'dark'):
        output = args.outdir / f'{scene}-{theme}.png'
        output.unlink(missing_ok=True)
        command = [str(args.binary), '--scene', native_scene, '--theme', theme, '--size', args.size, '--scale', str(args.scale), '--snap', str(output)]
        with tempfile.TemporaryDirectory() as temp:
            script = args.script
            capture_at = args.at
            if script is None and scene in ('studio-column-head-terminal-hover', 'studio-column-head-terminal-idle-hover'):
                # Electron reveals column tools while the pointer is over the
                # terminal body, but keeps them hidden over the header.
                script = Path(temp) / 'terminal-body-hover.json'
                script.write_text(json.dumps({'events': [
                    {'t': 1.3, 'type': 'move', 'x': 300, 'y': 180},
                ]}))
                capture_at = capture_at if capture_at is not None else 2.0
            elif script is None and scene == 'studio-column-head-terminal-selection':
                script = Path(temp) / 'terminal-selection.json'
                script.write_text(json.dumps({'events': [
                    {'t': 0.2, 'type': 'down', 'x': 283, 'y': 106},
                    {'t': 0.5, 'type': 'move', 'x': 322, 'y': 106},
                    {'t': 0.6, 'type': 'up', 'x': 322, 'y': 106},
                ]}))
                capture_at = capture_at if capture_at is not None else 0.8
            elif script is None and scene == 'studio-overview-hover':
                script = Path(temp) / 'overview-hover.json'
                script.write_text(json.dumps({'events': [
                    {'t': 1.3, 'type': 'move', 'x': 340, 'y': 250},
                ]}))
                capture_at = capture_at if capture_at is not None else 2.0
            elif script is None and scene == 'studio-overview-focus':
                script = Path(temp) / 'overview-focus.json'
                script.write_text(json.dumps({'events': [
                    {'t': 0.2, 'type': 'key', 'name': 'Tab'},
                ]}))
                capture_at = capture_at if capture_at is not None else 2.0
            elif script is None and scene == 'studio-overview-mid':
                script = Path(temp) / 'overview-mid.json'
                script.write_text(json.dumps({'events': [
                    {'t': 0.2, 'type': 'key', 'name': 'o', 'cmd': True, 'shift': True},
                ]}))
                # Pin the native easing at its halfway point even when the
                # caller supplies a settled-frame time for the other scenes.
                capture_at = 0.41
            if script:
                command += ['--script', str(script)]
            if capture_at is not None:
                command += ['--at', str(capture_at)]
            if native_scene.startswith('launcher-') and args.at is None:
                command += ['--at', '2.0']
            if hover:
                script = Path(temp) / 'hover.json'
                script.write_text(json.dumps({'events': [{'t': 1.3 + i / 120, 'type': 'move', 'x': 426 + i * 180 / 12, 'y': 428} for i in range(13)]}))
                command += ['--script', str(script), '--at', '2.1']
            print(f'Capturing {scene} {theme}', flush=True)
            subprocess.run(command, check=True, timeout=args.timeout)
        if not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError(f'Capture did not produce {output}')

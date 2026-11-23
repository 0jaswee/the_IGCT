export function setupDrawingTools(canvas) {
  const display = canvas.getBoundingClientRect();
  const scale = Math.min(1.5, 1100 / Math.max(display.width, display.height));
  canvas.width = Math.max(1, Math.round(display.width * scale));
  canvas.height = Math.max(1, Math.round(display.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const ink = document.querySelector('#ink');
  const size = document.querySelector('#stroke-size');
  const tools = [...document.querySelectorAll('[data-tool]')];
  const undo = document.querySelector('#undo-doodle');
  const redo = document.querySelector('#redo-doodle');
  const history = [];
  const forward = [];
  let tool = 'brush';
  let eraserSize = 10;
  let stroke;

  function clear() {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  }
  function remember() {
    if (history.length === 8) history.shift();
    const pixels = ctx.getImageData(0, 0, width, height);
    history.push(pixels);
    forward.length = 0;
    undo.disabled = false;
    redo.disabled = true;
    return pixels;
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width - 1, Math.floor((event.clientX - rect.left) * width / rect.width))),
      y: Math.max(0, Math.min(height - 1, Math.floor((event.clientY - rect.top) * height / rect.height)))
    };
  }
  function draw(to) {
    const { from, last, base, mode, color, thickness } = stroke;
    ctx.strokeStyle = mode === 'eraser' ? '#fff' : color;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (mode === 'circle' || mode === 'box' || mode === 'line') {
      ctx.putImageData(base, 0, 0);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      if (mode === 'box') ctx.strokeRect(from.x, from.y, dx, dy);
      else if (mode === 'line') {
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      } else if (dx && dy) {
        ctx.beginPath();
        ctx.ellipse(from.x + dx / 2, from.y + dy / 2, Math.abs(dx / 2), Math.abs(dy / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(to.x + 0.01, to.y);
    ctx.stroke();
    stroke.last = to;
  }
  function fill(from) {
    const image = ctx.getImageData(0, 0, width, height);
    const pixels = new Uint32Array(image.data.buffer);
    const initial = from.y * width + from.x;
    const target = pixels[initial];
    const rgb = ink.value.slice(1).match(/../g).map(value => parseInt(value, 16));
    const mark = new Uint32Array(Uint8Array.of(...rgb, 255).buffer)[0];
    if (target === mark) return;
    remember();
    const queue = new Int32Array(pixels.length);
    let tail = 0;
    function visit(index) {
      if (pixels[index] !== target) return;
      pixels[index] = mark;
      queue[tail++] = index;
    }
    visit(initial);
    for (let head = 0; head < tail; head++) {
      const index = queue[head];
      if (index % width > 0) visit(index - 1);
      if (index % width < width - 1) visit(index + 1);
      if (index >= width) visit(index - width);
      if (index < pixels.length - width) visit(index + width);
    }
    ctx.putImageData(image, 0, 0);
  }

  clear();
  undo.disabled = true;
  redo.disabled = true;
  tools.forEach(button => button.addEventListener('click', () => {
    tool = button.dataset.tool;
    if (tool === 'eraser') eraserSize = Number(button.dataset.thickness);
    tools.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  canvas.addEventListener('pointerdown', event => {
    if (stroke || event.button !== 0) return;
    const from = point(event);
    if (tool === 'fill') return fill(from);
    if (tool === 'picker') {
      const rgb = ctx.getImageData(from.x, from.y, 1, 1).data.slice(0, 3);
      ink.value = '#' + Array.from(rgb, value => value.toString(16).padStart(2, '0')).join('');
      tools[0].click();
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    stroke = { id: event.pointerId, from, last: from, base: remember(), mode: tool, color: ink.value,
      thickness: tool === 'eraser' ? eraserSize : Number(size.value) };
    draw(from);
  });
  canvas.addEventListener('pointermove', event => {
    if (stroke?.id === event.pointerId) draw(point(event));
  });
  canvas.addEventListener('pointerup', event => {
    if (stroke?.id !== event.pointerId) return;
    draw(point(event));
    stroke = null;
  });
  for (const eventName of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(eventName, event => {
      if (stroke?.id === event.pointerId) stroke = null;
    });
  }
  undo.addEventListener('click', () => {
    if (!history.length || stroke) return;
    forward.push(ctx.getImageData(0, 0, width, height));
    ctx.putImageData(history.pop(), 0, 0);
    undo.disabled = !history.length;
    redo.disabled = false;
  });
  redo.addEventListener('click', () => {
    if (!forward.length || stroke) return;
    history.push(ctx.getImageData(0, 0, width, height));
    ctx.putImageData(forward.pop(), 0, 0);
    undo.disabled = false;
    redo.disabled = !forward.length;
  });
  document.querySelector('#clear-doodle').addEventListener('click', () => {
    if (!stroke) { remember(); clear(); }
  });
  document.querySelector('#download-doodle').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = 'igct-doodle.png';
    link.click();
  });
}


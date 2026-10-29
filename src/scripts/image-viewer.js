// Full-screen, zoomable view of the sounding image: wheel/pinch zoom toward the pointer,
// drag to pan, double-click to zoom in, and keyboard controls. No library needed.

const MAX_SCALE = 4; // 400% of the plot's real pixel size
const STEP = 1.4;    // zoom step for the buttons and +/- keys
const PAN = 80;      // px per arrow-key press

// Keep the image on screen: centred on an axis where it's smaller than the stage,
// otherwise its edges can't be dragged inside the stage.
export function clampOffset(offset, size, stage) {
  return size <= stage ? (stage - size) / 2 : Math.min(0, Math.max(stage - size, offset));
}

// The offset that keeps the image point under `point` fixed while scale changes.
export function zoomOffset(offset, point, scale, next) {
  return point - (point - offset) * (next / scale);
}

export function createViewer(dialog, { onCopy }) {
  const stage = dialog.querySelector(".spy-viewer-stage");
  const img = dialog.querySelector(".spy-viewer-img");
  const readout = dialog.querySelector(".spy-viewer-zoom");
  const view = { scale: 1, x: 0, y: 0, fit: 1 };
  const pointers = new Map();
  let drag = null, pinch = null;

  function apply() {
    view.x = clampOffset(view.x, img.naturalWidth * view.scale, stage.clientWidth);
    view.y = clampOffset(view.y, img.naturalHeight * view.scale, stage.clientHeight);
    img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    readout.value = `${Math.round(view.scale * 100)}%`;
  }

  function fit() {
    if (!img.naturalWidth) return;
    view.fit = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight) * 0.96;
    view.scale = view.fit;
    apply(); // clampOffset centres it
  }

  function zoomTo(next, px = stage.clientWidth / 2, py = stage.clientHeight / 2) {
    next = Math.min(MAX_SCALE, Math.max(view.fit, next));
    view.x = zoomOffset(view.x, px, view.scale, next);
    view.y = zoomOffset(view.y, py, view.scale, next);
    view.scale = next;
    apply();
  }

  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  // Wheel and trackpad pinch (which arrives as a ctrl+wheel event) zoom toward the pointer.
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomTo(view.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), ...local(e));
  }, { passive: false });

  stage.addEventListener("dblclick", (e) => {
    if (view.scale > view.fit * 1.05) fit();
    else zoomTo(view.fit * 2.5, ...local(e));
  });

  // One pointer drags; two pointers (touch) pinch-zoom around their midpoint.
  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) drag = { start: local(e), x: view.x, y: view.y };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, scale: view.scale };
      drag = null;
    }
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoomTo(pinch.scale * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.dist, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    } else if (drag) {
      const [px, py] = local(e);
      view.x = drag.x + px - drag.start[0];
      view.y = drag.y + py - drag.start[1];
      apply();
    }
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) drag = { start: [...pointers.values()][0], x: view.x, y: view.y }; // keep panning with the other finger
    if (!pointers.size) { drag = null; stage.classList.remove("is-dragging"); }
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);

  dialog.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const keys = {
      "+": () => zoomTo(view.scale * STEP), "=": () => zoomTo(view.scale * STEP),
      "-": () => zoomTo(view.scale / STEP), "_": () => zoomTo(view.scale / STEP),
      "0": fit,
      ArrowLeft: () => { view.x += PAN; apply(); }, ArrowRight: () => { view.x -= PAN; apply(); },
      ArrowUp: () => { view.y += PAN; apply(); }, ArrowDown: () => { view.y -= PAN; apply(); },
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });

  dialog.addEventListener("click", (e) => {
    const action = e.target.closest("[data-viewer]")?.dataset.viewer;
    if (action === "in") zoomTo(view.scale * STEP);
    else if (action === "out") zoomTo(view.scale / STEP);
    else if (action === "fit") fit();
    else if (action === "close") dialog.close();
    else if (action === "copy") onCopy(e.target.closest("[data-viewer]").querySelector("span"));
  });

  window.addEventListener("resize", () => {
    if (!dialog.open) return;
    if (view.scale <= view.fit * 1.001) fit(); else apply();
  });

  return {
    async open(src, title) {
      img.src = src;
      dialog.querySelector(".spy-viewer-title").textContent = title;
      dialog.querySelector(".spy-viewer-download").href = src;
      dialog.showModal();
      await img.decode().catch(() => {});
      fit();
      stage.focus();
    },
  };
}

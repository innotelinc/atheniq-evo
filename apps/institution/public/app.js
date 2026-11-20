/* Two small enhancements. Nothing essential depends on JavaScript. */
(() => {
  const items = document.querySelectorAll("[data-reveal]");
  if (items.length && "IntersectionObserver" in window) {
    document.documentElement.classList.add("reveal-ready");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    items.forEach((item) => observer.observe(item));
  }

  // A horizontally scrolling table needs to be reachable without a pointer.
  document.querySelectorAll(".table-wrap").forEach((wrap) => {
    wrap.tabIndex = 0;
  });

  const counters = document.querySelectorAll("[data-counter-for]");
  counters.forEach((label) => {
    const field = document.getElementById(label.dataset.counterFor || "");
    if (!field) return;
    const update = () => {
      const length = field.value.length;
      label.textContent = `${length} / 4000`;
    };
    field.addEventListener("input", update);
    update();
  });
})();

/* Shared Berlin tower. Source: meta-uber-engineer/assets/berlin-tower.js. */
(() => {
  if (customElements.get('berlin-tower')) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  class BerlinTower extends HTMLElement {
    connectedCallback() {
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        :host { display: inline-block; width: 30px; height: 45px; }
        button { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; }
        button:focus-visible { outline: 2px solid currentColor; outline-offset: 5px; border-radius: 2px; }
        button > svg { display: block; width: 100%; height: 100%; overflow: visible; }
        svg { fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: square; stroke-linejoin: miter; }
        [data-tower-base] { transform-origin: 32px 84px; }
        circle { fill: var(--tower-ball-color, #ff5a36); }
      </style><button type="button" aria-label="Replay tower animation"><svg viewBox="0 0 64 96" aria-hidden="true">
        <svg x="0" y="0" width="64" height="84" viewBox="0 0 64 84" style="overflow:hidden">
          <g data-tower-spire><line x1="32" y1="3" x2="32" y2="39"/><path d="M32 39 L25 84 M32 39 L39 84"/></g>
        </svg>
        <path data-tower-base d="M21 84 H43"/>
        <circle data-tower-ball cx="32" cy="29" r="10"/>
      </svg></button>`;
      const tower = shadow.querySelector('svg');
      let animations = [];
      const play = () => {
        animations.forEach((animation) => animation.cancel());
        animations = [];
        if (reducedMotion.matches) return;
        const animate = (selector, frames, options) => {
          const animation = tower.querySelector(selector).animate(frames, { fill: 'both', ...options });
          animations.push(animation);
        };
        animate('[data-tower-base]', [
          { transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }
        ], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
        animate('[data-tower-spire]', [
          { transform: 'translateY(84px)' }, { transform: 'translateY(0)' }
        ], { delay: 140, duration: 440, easing: 'cubic-bezier(.16,1,.3,1)' });
        animate('[data-tower-ball]', [
          { transform: 'translateY(-100px)', opacity: 0, offset: 0, easing: 'cubic-bezier(.55,0,1,.6)' },
          { transform: 'translateY(0)', opacity: 1, offset: .65, easing: 'cubic-bezier(0,.4,.4,1)' },
          { transform: 'translateY(-7px)', opacity: 1, offset: .82, easing: 'cubic-bezier(.5,0,1,1)' },
          { transform: 'translateY(0)', opacity: 1, offset: 1 }
        ], { delay: 500, duration: 480 });
      };

      this.observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        this.observer.disconnect();
        play();
      }, { threshold: .8 });
      this.observer.observe(this);
      shadow.querySelector('button').addEventListener('click', play);
      const stop = () => animations.forEach((animation) => animation.cancel());
      const motionChanged = () => { if (reducedMotion.matches) stop(); };
      reducedMotion.addEventListener('change', motionChanged);
      this.cleanup = () => { stop(); reducedMotion.removeEventListener('change', motionChanged); };
    }
    disconnectedCallback() {
      this.observer?.disconnect();
      this.cleanup?.();
    }
  }
  customElements.define('berlin-tower', BerlinTower);
})();

/* โลโก้ชามก๋วยเตี๋ยว (วาดเป็น SVG ไม่ต้องใช้รูป) ใส่ในทุกจุดที่มี data-bowl */
const BOWL_SVG = `
<svg viewBox="0 0 120 104" fill="none" aria-hidden="true">
  <path d="M44 7c-4 6 4 9 0 15M60 2c-4 6 4 9 0 15M76 7c-4 6 4 9 0 15" style="stroke:var(--bowl,#fff)" stroke-width="3.5" stroke-linecap="round" opacity=".5"/>
  <path d="M84 12 106 40M94 9 114 34" stroke="#F2B134" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M10 52h100c0 27-21 46-50 46S10 79 10 52Z" style="fill:var(--bowl,#fff)"/>
  <path d="M12 63h96" stroke="#CF2A1D" stroke-width="5"/>
  <path d="M46 99h28" style="stroke:var(--bowl,#fff)" stroke-width="5" stroke-linecap="round"/>
  <ellipse cx="60" cy="52" rx="50" ry="13" fill="#F2B134"/>
  <path d="M22 52c7-9 13 9 20 0s13 9 20 0 13 9 20 0 10 5 14 2" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
document.querySelectorAll('[data-bowl]').forEach(el => { el.innerHTML = BOWL_SVG; });

<!--
  FireworksCelebration.svelte — Fireworks animation overlay.

  Displayed when a card is moved to the "Complete" column via SSE.
  Shows confetti particles, sparkles, and a congratulatory message
  with the card title, user info, and XP gained.
-->
<script lang="ts">
  /**
   * @prop cardTitle — The title of the completed card
   * @prop userName — The name of the user who completed it
   * @prop userEmoji — The emoji avatar of the user
   * @prop xpGained — Amount of XP earned for completion
   */
  let {
    cardTitle = '',
    userName = 'Someone',
    userEmoji = '👤',
    xpGained = 0
  }: {
    cardTitle: string;
    userName: string;
    userEmoji: string;
    xpGained: number;
  } = $props();
</script>

<div class="fireworks-overlay">
  <div class="fireworks-backdrop"></div>
  <div class="fireworks-stripe"></div>
  <!-- Confetti particles — randomised position, size, colour, and timing -->
  {#each Array(60) as _, i}
    <div class="firework-particle" style="
      --x: {Math.random() * 100}vw;
      --y: {Math.random() * 100}vh;
      --start-x: {30 + Math.random() * 40}vw;
      --start-y: {40 + Math.random() * 20}vh;
      --delay: {Math.random() * 0.8}s;
      --size: {3 + Math.random() * 10}px;
      --color: hsl({Math.random() * 360}, 85%, {50 + Math.random() * 20}%);
      --duration: {0.8 + Math.random() * 1.8}s;
      --spin: {Math.random() * 720}deg;
    "></div>
  {/each}
  <!-- Sparkle dots — smaller, sharper pops -->
  {#each Array(20) as _, i}
    <div class="firework-sparkle" style="
      --x: {Math.random() * 100}vw;
      --y: {Math.random() * 100}vh;
      --delay: {0.2 + Math.random() * 0.6}s;
      --color: hsl({Math.random() * 60 + 30}, 100%, 70%);
    "></div>
  {/each}
  <!-- Centre text overlay -->
  <div class="firework-center">
    <div class="firework-text">🎉 Complete!</div>
    {#if cardTitle}
      <div class="firework-card-title">"{cardTitle}"</div>
    {/if}
    <div class="firework-user">{userEmoji} {userName}{#if xpGained} <span class="firework-xp">+{xpGained} XP</span>{/if}</div>
  </div>
</div>

<style>
  .fireworks-overlay {
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    z-index: 9999; pointer-events: none;
    animation: fireworksFade 3s ease-out forwards;
  }
  .fireworks-backdrop {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.35);
    animation: backdropFade 3s ease-out forwards;
  }
  .fireworks-stripe {
    position: absolute; top: 50%; left: 0; right: 0;
    height: 140px; transform: translateY(-50%);
    background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.75) 15%, rgba(0, 0, 0, 0.75) 85%, transparent);
    animation: stripeFade 3s ease-out forwards;
  }
  .firework-particle {
    position: absolute;
    left: var(--start-x); top: var(--start-y);
    width: var(--size); height: var(--size);
    background: var(--color);
    border-radius: 50%;
    animation: fireworkBurst var(--duration) var(--delay) ease-out forwards;
    box-shadow: 0 0 6px var(--color), 0 0 14px var(--color);
  }
  .firework-sparkle {
    position: absolute;
    left: var(--x); top: var(--y);
    width: 3px; height: 3px;
    background: var(--color);
    border-radius: 50%;
    animation: sparklePop 0.6s var(--delay) ease-out forwards;
    box-shadow: 0 0 8px var(--color), 0 0 20px var(--color);
    opacity: 0;
  }
  .firework-center {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1; text-align: center;
    animation: fireworkTextPop 0.6s ease-out forwards;
    white-space: nowrap;
  }
  .firework-text {
    font-size: 2.8rem; font-weight: 900; letter-spacing: -0.02em;
    background: linear-gradient(135deg, #fbbf24, #f472b6, #818cf8, #34d399);
    background-size: 300% 300%;
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
    animation: textShimmer 1.5s ease-in-out infinite;
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
    line-height: 1.1;
  }
  .firework-card-title {
    font-size: 1.1rem; font-weight: 600; color: rgba(255, 255, 255, 0.9);
    margin-top: 4px; font-style: italic;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    max-width: 400px; overflow: hidden; text-overflow: ellipsis;
  }
  .firework-user {
    font-size: 0.85rem; font-weight: 500; color: rgba(255, 255, 255, 0.6);
    margin-top: 6px;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  }
  .firework-xp {
    display: inline-block; margin-left: 8px;
    padding: 1px 8px; border-radius: var(--radius-full);
    background: rgba(245, 158, 11, 0.25); color: #fbbf24;
    font-weight: 700; font-size: 0.8rem;
  }
  @keyframes fireworkBurst {
    0% { transform: translate(0, 0) scale(1) rotate(0deg); opacity: 1; }
    70% { opacity: 0.8; }
    100% { transform: translate(calc(var(--x) - var(--start-x)), calc(var(--y) - var(--start-y))) scale(0) rotate(var(--spin)); opacity: 0; }
  }
  @keyframes sparklePop {
    0% { opacity: 0; transform: scale(0); }
    50% { opacity: 1; transform: scale(3); }
    100% { opacity: 0; transform: scale(0); }
  }
  @keyframes fireworkTextPop {
    0% { opacity: 0; transform: translate(-50%, -50%) scale(0.3); }
    50% { opacity: 1; transform: translate(-50%, -50%) scale(1.15); }
    100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }
  @keyframes textShimmer {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  @keyframes backdropFade {
    0% { opacity: 0; } 15% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; }
  }
  @keyframes stripeFade {
    0% { opacity: 0; transform: translateY(-50%) scaleX(0); }
    15% { opacity: 1; transform: translateY(-50%) scaleX(1); }
    75% { opacity: 1; } 100% { opacity: 0; }
  }
  @keyframes fireworksFade {
    0%, 80% { opacity: 1; } 100% { opacity: 0; }
  }
</style>

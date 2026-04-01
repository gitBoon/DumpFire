<script lang="ts">
	import { tick } from 'svelte';

	let { value = '📋', onSelect }: { value?: string; onSelect: (emoji: string) => void } = $props();

	let showPicker = $state(false);
	let activeCategory = $state('Smileys');
	let triggerEl: HTMLButtonElement;
	let pickerStyle = $state('');

	const categories: Record<string, string[]> = {
		'Smileys': ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🤩','😘','😗','😙','😚','🙂','🤗','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','😴','🤤','😛','😜','😝','🤑','🤡','😈','👿','👻','💀','☠️','👽','🤖','💩','😺','😻'],
		'People': ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','👀','👁️','👅','👄','🧑','👨','👩','🧓','👴','👵'],
		'Animals': ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🦭'],
		'Food': ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🌮','🌯','🫔','🥗','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥'],
		'Travel': ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🛺','🚲','🛴','🚍','🚃','🚋','🚞','🚝','🚄','🚅','🚈','🚂','🚆','🚇','🚊','🚉','✈️','🛫','🛬','🛩️','🚀','🛸','🚁','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢','🏠','🏡','🏢','🏬','🏭','🏗️','🏰','🏯','🗼','🗽','⛪','🕌','🛕','🕍'],
		'Activities': ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🎯','🎮','🕹️','🎲','🧩','🃏','🀄','🎰','🎳','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻'],
		'Objects': ['💡','🔦','🕯️','🧯','💰','💳','💎','⚖️','🧰','🔧','🔨','⚒️','🛠️','⛏️','🪚','🔩','⚙️','🧱','⛓️','🔫','💣','🔪','🗡️','⚔️','🛡️','🔬','🔭','📡','💉','💊','🩸','🩹','🩺','🚪','🛏️','🪑','🚽','🪠','🚿','🛁','🪤','🧲','📱','💻','🖥️','🖨️','⌨️','🖱️','💾','📀','📷','📸','📹','🎥','📞','☎️','📺','📻','🎙️','📚','📖','📰','🗞️','📁','📂','📅','📆','🗓️','📇','🔖','🏷️'],
		'Symbols': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','⭐','🌟','💫','✨','⚡','🔥','💥','☀️','🌈','☁️','🌧️','⛈️','❄️','☃️','🌊','💧','💦','✅','❎','❌','⭕','💯','♻️','🔰','⚠️','🔱','⚜️','🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪','🟥','🟧','🟨','🟩','🟦','🟪','🟫','⬛','⬜','▪️','▫️'],
		'Flags': ['🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇬🇧','🇺🇸','🇫🇷','🇩🇪','🇮🇹','🇪🇸','🇯🇵','🇰🇷','🇨🇳','🇧🇷','🇮🇳','🇷🇺','🇦🇺','🇨🇦','🇲🇽','🇦🇷','🇿🇦','🇳🇬','🇪🇬','🇰🇪','🇸🇦','🇦🇪','🇹🇷','🇮🇪','🇳🇱','🇧🇪','🇨🇭','🇦🇹','🇵🇱','🇸🇪','🇳🇴','🇩🇰','🇫🇮','🇵🇹','🇬🇷','🇹🇭','🇻🇳','🇮🇩','🇵🇭','🇲🇾','🇸🇬','🇳🇿']
	};

	const categoryIcons: Record<string, string> = {
		'Smileys': '😀', 'People': '👋', 'Animals': '🐶', 'Food': '🍎',
		'Travel': '🚀', 'Activities': '🎮', 'Objects': '💡', 'Symbols': '❤️', 'Flags': '🏁'
	};

	async function togglePicker(e: MouseEvent) {
		e.stopPropagation();
		if (showPicker) {
			showPicker = false;
			return;
		}
		showPicker = true;
		await tick();
		if (triggerEl) {
			const rect = triggerEl.getBoundingClientRect();
			const spaceBelow = window.innerHeight - rect.bottom;
			const pickerH = 310;
			if (spaceBelow < pickerH) {
				pickerStyle = `position:fixed; bottom:${window.innerHeight - rect.top + 6}px; left:${rect.left}px;`;
			} else {
				pickerStyle = `position:fixed; top:${rect.bottom + 6}px; left:${rect.left}px;`;
			}
		}
	}

	$effect(() => {
		if (showPicker) {
			const handleClick = (e: MouseEvent) => {
				const target = e.target as HTMLElement;
				if (!target.closest('.emoji-picker-container') && !target.closest('.emoji-picker-fixed')) {
					showPicker = false;
				}
			};
			document.addEventListener('click', handleClick, true);
			return () => document.removeEventListener('click', handleClick, true);
		}
	});
</script>

<div class="emoji-picker-container">
	<button class="emoji-trigger" bind:this={triggerEl} onclick={togglePicker} type="button">
		<span class="emoji-preview">{value}</span>
		<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
			<path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
		</svg>
	</button>
</div>

{#if showPicker}
	<div class="emoji-picker-fixed" style={pickerStyle} onclick={(e) => e.stopPropagation()}>
		<div class="emoji-categories">
			{#each Object.keys(categories) as cat}
				<button
					class="emoji-cat-btn" class:active={activeCategory === cat}
					onclick={() => (activeCategory = cat)}
					title={cat}
				>{categoryIcons[cat]}</button>
			{/each}
		</div>
		<div class="emoji-grid-picker">
			{#each (categories[activeCategory] || []) as emoji}
				<button class="emoji-option" onclick={() => { onSelect(emoji); value = emoji; showPicker = false; }}>
					{emoji}
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	.emoji-picker-container { position: relative; display: inline-flex; }

	.emoji-trigger {
		display: flex; align-items: center; gap: 4px;
		padding: 6px 10px; border-radius: var(--radius-md);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		cursor: pointer; font-size: 1.4rem;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.emoji-trigger:hover { background: var(--glass-hover); border-color: var(--accent-indigo); }
	.emoji-trigger svg { color: var(--text-tertiary); }
	.emoji-preview { line-height: 1; }

	:global(.emoji-picker-fixed) {
		z-index: 9000; width: 320px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
		animation: pickerSlideIn 0.2s ease-out;
		overflow: hidden;
	}

	:global(.emoji-picker-fixed .emoji-categories) {
		display: flex; gap: 2px; padding: 8px 8px 4px;
		border-bottom: 1px solid var(--glass-border);
		overflow-x: auto;
	}
	:global(.emoji-picker-fixed .emoji-cat-btn) {
		flex-shrink: 0; width: 30px; height: 30px; font-size: 1rem;
		border-radius: var(--radius-sm); border: none; background: transparent;
		cursor: pointer; display: flex; align-items: center; justify-content: center;
		transition: all var(--duration-fast) var(--ease-out);
		opacity: 0.5;
	}
	:global(.emoji-picker-fixed .emoji-cat-btn:hover) { opacity: 0.85; background: var(--glass-hover); }
	:global(.emoji-picker-fixed .emoji-cat-btn.active) { opacity: 1; background: var(--glass-hover); }

	:global(.emoji-picker-fixed .emoji-grid-picker) {
		display: grid; grid-template-columns: repeat(8, 1fr);
		gap: 2px; padding: 8px; max-height: 220px; overflow-y: auto;
	}
	:global(.emoji-picker-fixed .emoji-option) {
		width: 34px; height: 34px; font-size: 1.2rem;
		border-radius: var(--radius-sm); border: none; background: transparent;
		cursor: pointer; display: flex; align-items: center; justify-content: center;
		transition: all 0.1s ease;
	}
	:global(.emoji-picker-fixed .emoji-option:hover) { background: var(--glass-hover); transform: scale(1.2); }

	@keyframes pickerSlideIn {
		from { opacity: 0; transform: translateY(-6px) scale(0.95); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}
</style>

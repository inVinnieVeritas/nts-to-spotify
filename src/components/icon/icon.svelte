<script lang="ts">
	import arrowRight from './icons/arrow-right.svg?raw';
	import coffee from './icons/coffee.svg?raw';
	import play from './icons/play.svg?raw';
	import replace from './icons/replace.svg?raw';
	import search from './icons/search.svg?raw';
	import spotify from './icons/spotify.svg?raw';
	import stop from './icons/stop.svg?raw';
	import github from './icons/github.svg?raw';

	import folder from './icons/folder.svg?raw';
	import check_circle from './icons/check-circle.svg?raw';
	import clock from './icons/clock.svg?raw';
	import x_circle from './icons/x-circle.svg?raw';
	import music from './icons/music.svg?raw';
	import link from './icons/link.svg?raw';
	import download from './icons/download.svg?raw';
	import trash from './icons/trash.svg?raw';
	import grid from './icons/grid.svg?raw';
	import list from './icons/list.svg?raw';
	import calendar from './icons/calendar.svg?raw';
	import history from './icons/history.svg?raw';
	import copy from './icons/copy.svg?raw';

	const icons = {
		['arrow-right']: arrowRight,
		coffee,
		play,
		replace,
		search,
		spotify,
		stop,
		github,
		folder: folder,
		'check-circle': check_circle,
		clock: clock,
		'x-circle': x_circle,
		music: music,
		link: link,
		download: download,
		trash: trash,
		grid: grid,
		list: list,
		calendar: calendar,
		history: history,
		copy: copy
	};

	export let icon: keyof typeof icons;
</script>

{@html icons[icon]}

module.exports = {
	plugins: [
		require('postcss-preset-env')({
			autoprefixer: {
				flexbox: 'no-2009'
			},
			features: {
				'custom-media-queries': {
					importFrom: ['./src/styles/media.pcss']
				},
				'nesting-rules': true,
				'focus-visible-pseudo-class': false,
				'custom-properties': false
			}
		})
	]
};

export const FLAGS = {
	ALPHA: 'alpha',
	BETA: 'beta',
}

export const NAMES = Object.keys(FLAGS)

export function isAlpha(flag) {
	return flag === FLAGS.ALPHA
}

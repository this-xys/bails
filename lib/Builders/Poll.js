import { BaseBuilder, generateWAMessageFromContent, prepareWAMessageMedia, generateMessageIDV2, crypto } from './shared.js';
class Poll extends BaseBuilder {
	#client;

	constructor(client) {
		super();
		if (!client) throw new Error('Socket is required');
		this.#client = client;

		this._name = '';
		this._values = [];
		this._selectableCount = 1;
		this._hideVoter = false;
		this._canAddOption = false;
		this._toAnnouncementGroup = false;
		this._correctAnswer;
		this._endDate;
	}

	setName(name) {
		if (typeof name !== 'string' || !name) throw new TypeError('setName(name) requires a non-empty string');
		this._name = name;
		return this;
	}

	addOption(name) {
		if (typeof name !== 'string' || !name) throw new TypeError('addOption(name) requires a non-empty string');
		this._values.push(name);
		return this;
	}

	addOptions(names) {
		if (!Array.isArray(names) || !names.length) throw new TypeError('addOptions(names) requires a non-empty array of strings');
		names.forEach((name) => this.addOption(name));
		return this;
	}

	setSelectable(count) {
		if (typeof count !== 'number' || count < 0) throw new TypeError('setSelectable(count) requires a non-negative number');
		this._selectableCount = count;
		return this;
	}

	setMultiSelect(canSelectMultiple = true) {
		this._selectableCount = canSelectMultiple ? 0 : 1;
		return this;
	}

	setHideVoter(hide = true) {
		this._hideVoter = hide;
		return this;
	}

	setCanAddOption(allow = true) {
		this._canAddOption = allow;
		return this;
	}

	setAnnouncementGroup(isAnnouncement = true) {
		this._toAnnouncementGroup = isAnnouncement;
		return this;
	}

	setEndDate(date) {
		this._endDate = date instanceof Date ? date : new Date(date);
		return this;
	}

	setQuiz(correctOptionName) {
		if (typeof correctOptionName !== 'string' || !correctOptionName) {
			throw new TypeError('setQuiz(correctOptionName) requires a non-empty string');
		}
		this._correctAnswer = correctOptionName;
		return this;
	}

	build() {
		if (!this._name) throw new Error('Poll requires a name (use setName())');
		if (this._values.length < 2) throw new Error('Poll requires at least 2 options (use addOption()/addOptions())');
		if (this._correctAnswer && !this._values.includes(this._correctAnswer)) {
			throw new Error('setQuiz(correctOptionName) must match one of the added options exactly');
		}

		return {
			poll: {
				name: this._name,
				values: this._values,
				selectableCount: this._selectableCount,
				toAnnouncementGroup: this._toAnnouncementGroup,
				hideVoter: this._hideVoter,
				canAddOption: this._canAddOption,
				...(this._endDate && { endDate: this._endDate }),
				...(this._correctAnswer && { pollType: 1, correctAnswer: this._correctAnswer }),
			},
		};
	}

	async send(jid, options = {}) {
		return this.#client.sendMessage(jid, this.build(), options);
	}
}

export { Poll };

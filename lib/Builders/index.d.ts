export const MESSAGE_BUILDER_VERSION: string;

export abstract class BaseBuilder {
	setTitle(title: string): this;
	setSubtitle(subtitle: string): this;
	setBody(body: string): this;
	setFooter(footer: string): this;
	setBotGroupParticipants(...fbids: string[]): this;
	setContextInfo(obj: Record<string, any>): this;
	addPayload(obj: Record<string, any>): this;
}

export interface LimitedTimeOfferParams {
	text?: string;
	url?: string;
	copy_code?: string;
	expiration_time?: number;
}

export interface BottomSheetParams {
	in_thread_buttons_limit?: number;
	divider_indices?: number[];
	list_title?: string;
	button_title?: string;
}

export interface TapTargetConfigurationParams {
	title?: string;
	description?: string;
	canonical_url?: string;
	domain?: string;
	buttonIndex?: number;
}

export interface BloksRef {
	$ref: string;
}
export interface BloksNodeBase {
	ref?: string;
}
export interface ColumnRowNode extends BloksNodeBase {
	component: 'Column' | 'Row';
	weight?: number;
	justify?: string;
	children?: BloksNode[];
}
export interface TextNode extends BloksNodeBase {
	component: 'Text';
	text: string;
	variant?: string;
}
export interface IconNode extends BloksNodeBase {
	component: 'Icon';
	name: string;
}
export interface DividerNode extends BloksNodeBase {
	component: 'Divider';
}
export interface ImageNode extends BloksNodeBase {
	component: 'Image';
	url: string;
	variant?: string;
	fit?: string;
}
export interface VideoNode extends BloksNodeBase {
	component: 'Video';
	url: string;
}
export interface ListNode extends BloksNodeBase {
	component: 'List';
	children?: BloksNode[];
}
export interface TextFieldNode extends BloksNodeBase {
	component: 'TextField';
	label?: string;
	value?: string;
	variant?: string;
}
export interface DateTimeInputNode extends BloksNodeBase {
	component: 'DateTimeInput';
	label?: string;
	value?: string;
	enableDate?: boolean;
	enableTime?: boolean;
}
export interface SliderNode extends BloksNodeBase {
	component: 'Slider';
	label?: string;
	min?: number;
	max?: number;
	value?: number;
}
export interface CheckBoxNode extends BloksNodeBase {
	component: 'CheckBox';
	label?: string;
	value?: boolean;
}
export interface ChoicePickerNode extends BloksNodeBase {
	component: 'ChoicePicker';
	label?: string;
	variant?: string;
	displayStyle?: string;
	options?: Array<{ label: string; value: string }>;
	value?: string;
}
export interface BloksButtonNode extends BloksNodeBase {
	component: 'Button';
	child?: BloksNode;
	variant?: string;
	action?: { call: string; args?: Record<string, any> };
}
export interface ModalNode extends BloksNodeBase {
	component: 'Modal';
	trigger: string | BloksRef;
	content: BloksNode | string | BloksRef;
}
export interface TabsNode extends BloksNodeBase {
	component: 'Tabs';
	tabs: Array<{ title: string; child: BloksNode }>;
}
export interface CardNode extends BloksNodeBase {
	component: 'Card';
	child?: BloksNode;
}
export interface AudioPlayerNode extends BloksNodeBase {
	component: 'AudioPlayer';
	url: string;
	description?: string;
}
export interface AnyBloksNode extends BloksNodeBase {
	component: string;
	[key: string]: any;
}
export type BloksNode =
	| ColumnRowNode
	| TextNode
	| IconNode
	| DividerNode
	| ImageNode
	| VideoNode
	| ListNode
	| TextFieldNode
	| DateTimeInputNode
	| SliderNode
	| CheckBoxNode
	| ChoicePickerNode
	| BloksButtonNode
	| ModalNode
	| TabsNode
	| CardNode
	| AudioPlayerNode
	| AnyBloksNode;

export class Button extends BaseBuilder {
	addRequestContactInfo(display_text?: string): this;
	constructor(client: any);
	setVideo(path: string | Buffer, options?: Record<string, any>): this;
	setImage(path: string | Buffer, options?: Record<string, any>): this;
	setDocument(path: string | Buffer, options?: Record<string, any>): this;
	setMedia(obj: Record<string, any>): this;
	clearButtons(): this;
	setParams(obj: Record<string, any>): this;
	setBloksWidget(tree: BloksNode, options?: { uuid?: string; catalogId?: string; surfaceId?: string; version?: string }): this;
	addButton(name: string, params: string | Record<string, any>): this;
	makeRow(header?: string, title?: string, description?: string, id?: string): this;
	makeSection(title?: string, highlight_label?: string): this;
	addSelection(title: string, options?: Record<string, any>): this;
	addReply(display_text: string, id: string, options?: Record<string, any>): this;
	addCall(display_text: string, phone_number: string, options?: Record<string, any>): this;
	addReminder(display_text: string, id: string, options?: Record<string, any>): this;
	addCancelReminder(display_text: string, id: string, options?: Record<string, any>): this;
	addAddress(display_text: string, id: string, options?: Record<string, any>): this;
	addLocation(options?: Record<string, any>): this;
	addUrl(display_text: string, url: string, webview_interaction?: boolean, options?: Record<string, any>): this;
	addCopy(display_text: string, copy_code: string, options?: Record<string, any>): this;
	addOpenWebview(title: string, url: string, options?: Record<string, any>): this;
	addCatalog(display_text?: string, options?: Record<string, any>): this;
	addViewCatalog(options?: Record<string, any>): this;
	addCallPermission(display_text?: string, options?: Record<string, any>): this;
	addPaymentInfo(payload?: Record<string, any>): this;
	addReviewAndPay(payload?: Record<string, any>): this;
	addTransactionDetails(payload?: Record<string, any>): this;
	addMultiProduct(payload?: Record<string, any>): this;
	addCardMessage(payload?: Record<string, any>): this;
	addOrderDetails(payload?: Record<string, any>): this;
	addOrderStatus(payload?: Record<string, any>): this;
	addPaymentStatus(payload?: Record<string, any>): this;
	addPaymentMethod(payload?: Record<string, any>): this;
	addTrackOrder(id: string, display_text?: string): this;
	addReorder(id: string, display_text?: string): this;
	addCancelOrder(id: string, display_text?: string): this;
	addClearChat(): this;
	addNavigateToScreen(screen: string, data?: Record<string, any>): this;
	addFlow(flow: Record<string, any>, display_text?: string): this;
	addVoiceCall(id: string, display_text?: string): this;
	addVideoCall(id: string, display_text?: string): this;
	setLimitedTimeOffer(params?: LimitedTimeOfferParams): this;
	setBottomSheet(params?: BottomSheetParams): this;
	setTapTargetConfiguration(params?: TapTargetConfigurationParams): this;
	toCard(): Promise<Record<string, any>>;
	build(jid: string, options?: Record<string, any>): Promise<Record<string, any>>;
	send(jid: string, options?: Record<string, any>): Promise<any>;

	static SPECIAL_FLOW: Record<string, { v: string; name: string }>;

	static confirm?: (client: any, text: string, options?: Record<string, any>) => Button;
	static yesNo?: (client: any, text: string, options?: Record<string, any>) => Button;
	static menu?: (client: any, options?: Record<string, any>) => Button;
}

export class RowBuilder {
	constructor();
	buttons: Record<string, any>[];
	button(displayText: string, buttonId?: string): this;
}

export class CardBuilder {
	constructor(client: any);
	title(text: string): this;
	text(text: string): this;
	image(path: string | Buffer, options?: Record<string, any>): this;
	button(displayText: string, buttonId?: string): this;
}

export class ButtonV2 extends BaseBuilder {
	constructor(client: any);
	addButton(displayText: string, buttonId?: string): this;
	button(displayText: string, buttonId?: string): this;
	row(cb: (row: RowBuilder) => void): this;
	addRawButton(obj: Record<string, any>): this;
	setThumbnail(path: string | Buffer): this;
	setMedia(obj: Record<string, any>): this;
	build(jid: string, options?: Record<string, any> & { viewOnce?: boolean }): Promise<Record<string, any>>;
	send(jid: string, options?: Record<string, any> & { viewOnce?: boolean }): Promise<any>;
}

export class ButtonV3 extends BaseBuilder {
	constructor(client: any);
	loadFrom(msg: Record<string, any>): this;
	setImage(path: string | Buffer, options?: Record<string, any>): this;
	setVideo(path: string | Buffer, options?: Record<string, any>): this;
	setDocument(path: string | Buffer, options?: Record<string, any>): this;
	setMedia(obj: Record<string, any>): this;
	clearButtons(): this;
	addButton(hydratedButton: Record<string, any>): this;
	addReply(display_text?: string, id?: string): this;
	addUrl(display_text?: string, url?: string, options?: Record<string, any>): this;
	addCall(display_text?: string, phone_number?: string): this;
	toTemplate(): Promise<Record<string, any>>;
	build(jid: string, options?: Record<string, any>): Promise<Record<string, any>>;
	send(jid: string, options?: Record<string, any>): Promise<any>;
}

export class Carousel extends BaseBuilder {
	constructor(client: any);
	static MAX_CARDS: number;
	addCard(card: Record<string, any> | Record<string, any>[]): this;
	build(jid: string, options?: Record<string, any>): Record<string, any>;
	send(jid: string, options?: Record<string, any>): Promise<any>;
}

export class Poll extends BaseBuilder {
	constructor(client: any);
	setName(name: string): this;
	addOption(name: string): this;
	addOptions(names: string[]): this;
	setSelectable(count: number): this;
	setMultiSelect(canSelectMultiple?: boolean): this;
	setHideVoter(hide?: boolean): this;
	setCanAddOption(allow?: boolean): this;
	setAnnouncementGroup(isAnnouncement?: boolean): this;
	setEndDate(date: Date | string | number): this;
	setQuiz(correctOptionName: string): this;
	build(): { poll: Record<string, any> };
	send(jid: string, options?: Record<string, any>): Promise<any>;
}

export interface AddTextOptions {
	deeplink?: boolean;
	hyperlink?: boolean;
	citation?: boolean;
	latex?: boolean;
}

export interface AddInlineImageOptions {
	text?: string;
	alignment?: string;
	tapLinkUrl?: string;
	resolveUrl?: boolean;
}

export class Event {
	constructor(client: { sendMessage: (...a: any[]) => Promise<any> });
	setName(name: string): this;
	setDescription(text: string): this;
	setStart(when: Date | number): this;
	setEnd(when: Date | number): this;
	setLocation(location: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string }): this;
	setCall(kind: 'audio' | 'video'): this;
	setCancelled(v?: boolean): this;
	setExtraGuestsAllowed(v?: boolean): this;
	setScheduleCall(v?: boolean): this;
	setReminder(seconds: number): this;
	clearReminder(): this;
	setBotFbid(...fbids: string[]): this;
	build(): { event: Record<string, any> };
	send(jid: string, options?: Record<string, any>): Promise<any>;
}

export class Album {
	constructor(client: { sendAlbumMessage?: (...a: any[]) => Promise<any>; sendMessage?: (...a: any[]) => Promise<any> });
	static readonly MAX_ITEMS: number;
	addImage(source: any, caption?: string, extra?: Record<string, any>): this;
	addVideo(source: any, caption?: string, extra?: Record<string, any>): this;
	addMany(items: Array<{ image?: any; video?: any; caption?: string; [k: string]: any }>): this;
	setCaption(caption: string): this;
	setDelay(ms: number): this;
	setContinueOnError(v?: boolean): this;
	build(): { album: Array<Record<string, any>>; caption?: string };
	send(jid: string, options?: Record<string, any>): Promise<any>;
}

export class AIRichError extends Error { code: string; constructor(message: string, code?: string, meta?: Record<string, any>); }
export class ItemNotFoundError extends AIRichError {}
export class DuplicateIdError extends AIRichError {}
export class InvalidTargetError extends AIRichError {}
export class ContentValidationError extends AIRichError {}

export class Expiring {
	constructor(client: { sendMessage: (...a: any[]) => Promise<any> }, builder: { send: (...a: any[]) => Promise<any> }, seconds?: number);
	send(jid: string, opts?: Record<string, any>): Promise<any>;
}
export { Expiring as ExpiringButton };

export class A2UI {
	constructor(client?: any, ...rest: any[]);
	slider(o?: { id?: string; value?: number; min?: number; max?: number; step?: number; label?: string }): string;
	dateTimeInput(label: string, o?: { id?: string; value?: string; enableDate?: boolean; enableTime?: boolean }): string;
	switch(label: string, o?: { id?: string; value?: boolean }): string;
	list(children: string[], o?: { id?: string }): string;
	progressBar(value: number, o?: { id?: string; min?: number; max?: number; variant?: string }): string;
	avatar(url: string, o?: { id?: string; variant?: string; size?: number }): string;
	badge(childId: string, o?: { id?: string; label?: string }): string;
	spacer(o?: { id?: string; height?: number }): string;
	tabs(items: Array<{ title: string; child: string }> | string[], o?: { id?: string; activeTab?: number }): string;
	[key: string]: any;
}

export interface BlockOptions { id?: string; insertAt?: string; replace?: string }

export class AIRich extends BaseBuilder {
	constructor(client: any);
	readonly isSignaturePreserved: boolean;
	addFooterSection(section: Record<string, any>): this;
	clearFooterSections(): this;
	addEmbeddedScreen(screen: Record<string, any>): this;
	setBotMetadata(extra: Record<string, any>): this;
	setResponseMeta(meta: Record<string, any>): this;
	setNotification(v: boolean, options?: { disclaimerText?: string }): this;
	addSubmessage(submessage: Record<string, any>): this;
	addSection(section: Record<string, any>): this;
	addText(text: string, options?: AddTextOptions): this;
	addCode(language: string, code: string): this;
	addTable(table: string[][], options?: AddTextOptions): this;
	addPaymentKeyInfo(payload?: Record<string, any>): this;
	addBookingConfirmation(payload?: Record<string, any>): this;
	addLinks(links?: Record<string, any>[]): this;
	addContentItems(items?: Record<string, any>[]): this;
	addInlineVideo(): this;
	addSource(sources?: Record<string, any>[], options?: { resolveUrl?: boolean }): this;
	addReels(reelsItems?: Record<string, any>[], options?: { resolveUrl?: boolean }): this;
	addImage(imageUrl: string, options?: { resolveUrl?: boolean }): this;
	addInlineImage(imageUrl: string, options?: AddInlineImageOptions): this;
	addVideo(videoUrl: string, options?: { autoFill?: boolean; resolveUrl?: boolean }): this;
	addProduct(data?: Record<string, any>, options?: { resolveUrl?: boolean }): this;
	addPost(data?: Record<string, any>, options?: { resolveUrl?: boolean }): this;
	addTip(text: string): this;
	addMetadata(text: string): this;
	setResponseId(id: string): this;
	refreshResponseId(): this;
	setBotResponseId(id: string): this;
	refreshBotResponseId(): this;
	hasId(id: string): boolean;
	getIds(): string[];
	peek(id: string): { id: string; sections: any[]; submessages: any[] } | null;
	delete(id: string): this;
	addHeading(text: string): this;
	addWidget(data: Record<string, any> | Record<string, any>[], options?: { layout?: 'Single' | 'HScroll' | 'ActionRow' | string }): this;
	addFooterAction(actions: { text: string; url: string; type?: string } | { text: string; url: string; type?: string }[]): this;
	addDivider(): this;
	addSpacer(spacing?: number): this;
	addLatex(expression: string): this;
	addTask(data: { task_id?: string; title: string; subtitle?: string; status?: string; textFallback?: boolean }): this;
	addProgressStatus(title: string, options?: { icon?: string; is_in_progress?: boolean; target_secondary_screen_id?: string; target_secondary_screen_tab_id?: string }): this;

	addImageCard(previewUrl: string | Buffer, fullUrl?: string | Buffer, options?: { width?: number; height?: number; status?: string; update_text?: string; resolveUrl?: boolean; id?: string; replace?: string; insertAt?: string }): this;
	addComment(comment: { actorName?: string; actor_name?: string; commentText?: string; comment_text?: string; subtitle?: string }, options?: { id?: string; replace?: string; insertAt?: string }): this;
	addActionList(rows: { title: string; subtitle?: string }[], options?: { id?: string; replace?: string; insertAt?: string }): this;
	addChainOfThoughtStep(title: string, body?: string, options?: { id?: string; replace?: string; insertAt?: string }): this;
	addThinking(title?: string, options?: { icon?: string; is_in_progress?: boolean; id?: string; replace?: string; insertAt?: string }): this;
	addPrimitive(typeName: string, payload: Record<string, any>, options?: { id?: string; replace?: string; insertAt?: string }): this;
	addContentRaw(section: any, submessage?: any, options?: { id?: string; replace?: string; insertAt?: string }): this;
	addThinkingStatus(title: string, options?: { icon?: string; is_in_progress?: boolean; target_secondary_screen_id?: string; target_secondary_screen_tab_id?: string; textFallback?: boolean }): this;
	addQuotaUpsell(data: { title: string; body?: string; body_line1?: string; body_line2?: string; buttons?: { label: string; action?: string; deeplink?: string }[] }): this;
	addBloks(data: { type: string; data?: string; uuid?: string; initial_response?: any; versioning_id?: string; textFallback?: boolean }): this;
	addSuggest(suggestion: Record<string, any>, options?: { scroll?: boolean; layout?: string }): this;
	setForwardBotJid(jid: string): this;

	setForwardBotJID(jid: string): this;
	setVerificationMetadata(enabled?: boolean): this;
	setNotification(enabled?: boolean, text?: string): this;
	setMentions(...jids: (string | string[])[]): this;
	setQuoted(quoted?: Record<string, any> | null, participant?: string): this;
	setNoContextInfo(enabled?: boolean): this;
	setDynamicIDs(enabled?: boolean): this;
	setUnifiedResponseData(data: Record<string, any> | string | Buffer | null): this;
	setMessageSecret(enabled?: boolean): this;
	setUnsupportedTypeAlert(enabled?: boolean): this;
	setByPassDownload(enabled?: boolean): this;
	setCapabilities(capabilities: Array<string | number>): this;
	setBotRenderingConfig(bloksVersioningId: string, pixelDensity?: number): this;
	setThreadType(type: string | number): this;
	setImagineType(type: string | number): this;
	setSubscriptionUpsell(requestType: string | number): this;
	buildEditNative(targetJid: string, targetId: string, options?: { msg?: Record<string, any>; messageId?: string; [key: string]: any }): Promise<any>;
	sendEditNative(jid?: string, id?: string, options?: { msg?: Record<string, any>; messageId?: string; additionalNodes?: any[]; [key: string]: any }): Promise<any>;
	addChainingSuggestionV2(options: BlockOptions & { promptText: string; title?: string; imageUri?: string; externalConversationId?: string; topic?: string; cardId?: string }): this;
	addPlaceEntity(options: BlockOptions & { name: string; placeId?: string; imageUrl?: string; motivation?: string; key?: string; latitude?: number | string; longitude?: number | string; itemType?: string; address?: { streetAddress?: string; region?: string; country?: string; postalCode?: string; locality?: string; street?: string }; category?: { displayName?: string; categoryId?: string }; rating?: number | string }): this;
	addSearchResultV2(options: BlockOptions & { searchQuery?: string; metadata?: string; postId?: string; reelsUrl?: string; reelsDeeplink?: string; reelsTitle?: string; thumbnailUrl?: string; avatarUrl?: string; creator?: string; isVerified?: boolean; sourceApp?: string; timestamp?: string; originalWidth?: number; originalHeight?: number; primitives?: Record<string, any>[] }): this;
	addContextualSources(sources: Array<{ faviconUri?: string; displayName: string; uri: string }>, contextualSources?: string | Record<string, any>, options?: BlockOptions): this;
	addMediaItem(options: BlockOptions & { url?: string; mediaId?: string; mimeType?: string; urlFallback?: string; fileLength?: number; width?: number; height?: number; durationMs?: number; expirationTimestampMs?: number; thumbnail?: string; encryption?: { mediaKey: string; directPath: string; fileSha256: string; fileEncSha256: string; scansSidecar?: string; scanLengths?: number[]; mediaKeyTimestamp?: number; fileLength?: number } }): this;
	addGenerating(options?: { imagine_type?: 'IMAGE' | 'ANIMATE'; estimated_completion_time?: number; textFallback?: boolean }): this;
	build(): Record<string, any>;
	send(jid: string, options?: Record<string, any>): Promise<any>;

	static tokenizer(code: string, lang?: string): Record<string, any>;
	static toTableMetadata(arr: string[][], options?: AddTextOptions): Record<string, any>;
	static newLayout(name: string, data: Record<string, any> | Record<string, any>[], extra?: Record<string, any>): Record<string, any>;
	static sendSupportPayload(client: any, jid: string, text: string, options?: { ticketId?: string; isAiMessage?: boolean; shouldShowSystemMessage?: boolean; version?: number }): Promise<any>;
	static sendPairedMedia(client: any, jid: string, media: { image: string | Buffer; video: string | Buffer }): Promise<any>;
}

export class ORich extends AIRich {}

export class Toolkit {
	static extractIE(text: string, options?: AddTextOptions): Record<string, any>;
	static getMp4Duration(buffer: Buffer, options?: { silent?: boolean }): Promise<number>;
	static getMp4Preview(
		videoBuffer: Buffer,
		options?: { time?: number; result?: 'buffer' | string; resize?: boolean; width?: number; height?: number; silent?: boolean }
	): Promise<Buffer | Record<string, any>>;
}

export function tokenizeCodeForRich(code: string, lang?: string): any;

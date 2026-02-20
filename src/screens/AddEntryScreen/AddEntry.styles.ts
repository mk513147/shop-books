import { StyleSheet } from "react-native";
import { theme } from "@theme";

export const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
	},

	formSection: {
		flex: 1,
		padding: 16,
	},

	summaryPanel: {
		position: "absolute",
		bottom: 0,
		left: 0,
		right: 0,
		backgroundColor: theme.colors.card,
		borderTopLeftRadius: 24,
		borderTopRightRadius: 24,
		paddingHorizontal: 16,
		paddingTop: 10,
		elevation: 10,
	},

	panelHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingBottom: 8,
	},

	panelTitle: {
		fontSize: 16,
		fontWeight: "700",
	},

	subHeading: {
		fontWeight: "600",
		marginTop: 10,
		marginBottom: 4,
	},

	row: {
		flexDirection: "row",
		justifyContent: "space-between",
		paddingVertical: 4,
	},

	totalRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		paddingVertical: 6,
		borderTopWidth: 1,
		borderColor: theme.colors.border,
		marginTop: 4,
	},

	toggleContainer: {
		flexDirection: "row",
		marginBottom: 20,
	},

	toggleButton: {
		flex: 1,
		padding: 14,
		alignItems: "center",
		borderRadius: 8,
		marginHorizontal: 4,
		borderWidth: 1,
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.card,
	},

	activeIncome: {
		backgroundColor: theme.colors.income,
		borderColor: theme.colors.income,
	},

	activeExpense: {
		backgroundColor: theme.colors.expense,
		borderColor: theme.colors.expense,
	},

	toggleText: {
		fontWeight: "600",
	},

	label: {
		marginTop: 16,
		marginBottom: 6,
		color: theme.colors.textPrimary,
		fontSize: 14,
	},

	amountInput: {
		backgroundColor: theme.colors.card,
		padding: 18,
		fontSize: 26,
		fontWeight: "700",
		borderRadius: 10,
	},

	input: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 8,
	},

	paymentRow: {
		flexDirection: "row",
		justifyContent: "space-between",
	},

	paymentButton: {
		flex: 1,
		padding: 12,
		marginHorizontal: 4,
		borderRadius: 8,
		alignItems: "center",
		borderWidth: 1,
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.card,
	},

	paymentActive: {
		backgroundColor: theme.colors.primary,
		borderColor: theme.colors.primary,
	},

	paymentText: {
		fontWeight: "600",
	},

	grid: {
		flexDirection: "row",
		flexWrap: "wrap",
		marginTop: 12,
	},

	imageBox: {
		width: "30%",
		aspectRatio: 1,
		margin: "1.5%",
		position: "relative",
	},

	previewImage: {
		width: "100%",
		height: "100%",
		borderRadius: 8,
	},

	removeImageButton: {
		position: "absolute",
		top: 6,
		right: 6,
		backgroundColor: theme.colors.expense,
		width: 22,
		height: 22,
		borderRadius: 11,
		justifyContent: "center",
		alignItems: "center",
	},

	imageButton: {
		marginTop: 20,
		flexDirection: "row",
		backgroundColor: theme.colors.primary,
		padding: 14,
		borderRadius: 8,
		justifyContent: "center",
		alignItems: "center",
	},

	imageButtonText: {
		color: "#fff",
		fontWeight: "600",
	},

	imagePreviewContainer: {
		marginTop: 12,
		position: "relative",
	},

	saveButton: {
		marginTop: 24,
		backgroundColor: theme.colors.primary,
		padding: 16,
		borderRadius: 10,
		alignItems: "center",
	},

	saveButtonText: {
		color: "#fff",
		fontSize: 16,
		fontWeight: "700",
	},
	pickerWrapper: {
		backgroundColor: theme.colors.card,
		borderRadius: 8,
	},

	sectionTitle: {
		fontSize: 16,
		fontWeight: "700",
		marginBottom: 10,
	},
});

import { StyleSheet } from "react-native";
import { theme } from "@theme";

export const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	header: {
		marginBottom: 16,
	},

	name: {
		fontSize: 20,
		fontWeight: "700",
		color: theme.colors.textPrimary,
	},

	totalDue: {
		fontSize: 28,
		fontWeight: "700",
		marginTop: 6,
	},

	card: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 8,
		marginBottom: 10,
	},

	date: {
		fontSize: 12,
		color: theme.colors.textSecondary,
	},

	desc: {
		fontSize: 14,
		fontWeight: "600",
		marginVertical: 4,
	},

	row: {
		flexDirection: "row",
		justifyContent: "space-between",
	},

	debit: {
		color: theme.colors.expense,
		fontWeight: "600",
	},

	credit: {
		color: theme.colors.income,
		fontWeight: "600",
	},

	balance: {
		fontWeight: "700",
	},

	actionRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginTop: 12,
	},

	button: {
		flex: 1,
		backgroundColor: theme.colors.primary,
		padding: 14,
		borderRadius: 8,
		alignItems: "center",
		marginHorizontal: 4,
	},

	buttonText: {
		color: "#fff",
		fontWeight: "600",
	},
});

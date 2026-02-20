import { StyleSheet } from "react-native";
import { theme } from "@theme";

export const styles = StyleSheet.create({
	container: {
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	dateText: {
		fontSize: 14,
		color: theme.colors.textSecondary,
		marginBottom: 12,
	},

	sectionTitle: {
		fontSize: 18,
		fontWeight: "600",
		marginBottom: 12,
		color: theme.colors.textPrimary,
	},

	summaryCard: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 10,
		marginBottom: 10,
	},

	profitCard: {
		backgroundColor: theme.colors.card,
		padding: 18,
		borderRadius: 10,
		marginBottom: 12,
	},

	label: {
		fontSize: 14,
		color: theme.colors.textSecondary,
	},

	value: {
		fontSize: 18,
		fontWeight: "600",
		marginTop: 4,
	},

	bigValue: {
		fontSize: 26,
		fontWeight: "700",
		marginTop: 6,
	},
});

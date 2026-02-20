import { Dimensions, StyleSheet } from "react-native";
import { theme } from "@theme";
const screenWidth = Dimensions.get("window").width;

export const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	header: {
		alignItems: "center",
		marginBottom: 20,
	},

	amount: {
		fontSize: 32,
		fontWeight: "700",
	},

	typeText: {
		marginTop: 6,
		fontWeight: "600",
		opacity: 0.6,
	},

	card: {
		backgroundColor: theme.colors.card,
		borderRadius: 12,
		padding: 16,
	},

	infoRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		paddingVertical: 8,
		borderBottomWidth: 1,
		borderColor: theme.colors.border,
	},

	label: {
		fontWeight: "600",
	},

	value: {
		opacity: 0.8,
	},

	sectionTitle: {
		fontWeight: "700",
		marginBottom: 10,
	},

	grid: {
		flexDirection: "row",
		flexWrap: "wrap",
	},

	imageBox: {
		width: "30%",
		aspectRatio: 1,
		margin: "1.5%",
	},

	previewImage: {
		width: "100%",
		height: "100%",
		borderRadius: 8,
	},

	buttonRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginTop: 10,
	},

	editButton: {
		flex: 1,
		backgroundColor: theme.colors.primary,
		padding: 14,
		borderRadius: 10,
		alignItems: "center",
		marginRight: 6,
		flexDirection: "row",
		justifyContent: "center",
	},

	deleteButton: {
		flex: 1,
		backgroundColor: theme.colors.expense,
		padding: 14,
		borderRadius: 10,
		alignItems: "center",
		marginLeft: 6,
		flexDirection: "row",
		justifyContent: "center",
	},

	buttonText: {
		color: "#fff",
		marginLeft: 6,
		fontWeight: "600",
	},

	modalContainer: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.9)",
		justifyContent: "center",
		alignItems: "center",
	},

	closeButton: {
		position: "absolute",
		top: 50,
		right: 20,
		zIndex: 10,
	},

	fullImage: {
		width: screenWidth,
		height: "80%",
	},
});

import { Dimensions, StyleSheet } from "react-native";
import { theme } from "@theme";

export const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	filterContainer: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginBottom: 16,
		backgroundColor: theme.colors.card,
		padding: 12,
		borderRadius: 8,
	},

	filterText: {
		color: theme.colors.textPrimary,
		fontSize: 14,
	},

	card: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 10,
		marginBottom: 12,
	},

	rowTop: {
		flexDirection: "row",
		justifyContent: "space-between",
	},

	rowBottom: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginTop: 8,
	},

	thumbnailRow: {
		flexDirection: "row",
		marginTop: 8,
	},

	thumbnailWrapper: {
		position: "relative",
		marginRight: 6,
	},

	overlay: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: "rgba(0,0,0,0.6)",
		justifyContent: "center",
		alignItems: "center",
		borderRadius: 6,
	},

	overlayText: {
		color: "#fff",
		fontWeight: "700",
		fontSize: 16,
	},

	viewerContainer: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.95)",
		justifyContent: "center",
		alignItems: "center",
	},

	viewerImage: {
		width: Dimensions.get("window").width,
		height: Dimensions.get("window").height * 0.7,
	},

	closeButton: {
		position: "absolute",
		top: 50,
		right: 20,
	},

	prevButton: {
		position: "absolute",
		left: 20,
		top: "50%",
	},

	nextButton: {
		position: "absolute",
		right: 20,
		top: "50%",
	},

	navText: {
		color: "#fff",
		fontSize: 40,
		fontWeight: "bold",
	},

	dateText: {
		color: theme.colors.textSecondary,
		fontSize: 13,
	},

	category: {
		marginTop: 4,
		fontWeight: "600",
		color: theme.colors.textPrimary,
	},

	supplier: {
		marginTop: 2,
		color: theme.colors.textSecondary,
		fontSize: 13,
	},

	paymentBadge: {
		paddingHorizontal: 10,
		paddingVertical: 4,
		backgroundColor: theme.colors.primary,
		color: "#fff",
		borderRadius: 6,
		fontSize: 12,
	},

	thumbnail: {
		width: 40,
		height: 40,
		borderRadius: 6,
	},
});

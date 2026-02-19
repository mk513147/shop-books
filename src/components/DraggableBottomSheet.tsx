import React, { useRef, useState } from "react";
import {
	Animated,
	PanResponder,
	Dimensions,
	View,
	StyleSheet,
} from "react-native";

type Props = {
	children: React.ReactNode;
	collapsedHeight?: number;
	expandedHeight?: number;
};

export default function DraggableBottomSheet({
	children,
	collapsedHeight = 80,
	expandedHeight,
}: Props) {
	const screenHeight = Dimensions.get("window").height;
	const EXPANDED_HEIGHT = expandedHeight ?? screenHeight * 0.6;

	const panelHeight = useRef(new Animated.Value(collapsedHeight)).current;

	const currentHeight = useRef(collapsedHeight);
	const [isExpanded, setIsExpanded] = useState(false);
	const startHeight = useRef(collapsedHeight);

	const expandPanel = () => {
		Animated.spring(panelHeight, {
			toValue: EXPANDED_HEIGHT,
			useNativeDriver: false,
			damping: 20,
			stiffness: 150,
		}).start();

		currentHeight.current = EXPANDED_HEIGHT;
		setIsExpanded(true);
	};

	const collapsePanel = () => {
		Animated.spring(panelHeight, {
			toValue: collapsedHeight,
			useNativeDriver: false,
			damping: 20,
			stiffness: 150,
		}).start();

		currentHeight.current = collapsedHeight;
		setIsExpanded(false);
	};

	const panResponder = useRef(
		PanResponder.create({
			onMoveShouldSetPanResponder: (_, gestureState) =>
				Math.abs(gestureState.dy) > 5,

			onPanResponderMove: (_, gestureState) => {
				let newHeight = startHeight.current - gestureState.dy;

				if (newHeight < collapsedHeight) newHeight = collapsedHeight;

				if (newHeight > EXPANDED_HEIGHT) newHeight = EXPANDED_HEIGHT;

				currentHeight.current = newHeight;
				panelHeight.setValue(newHeight);
			},

			onPanResponderRelease: (_, gestureState) => {
				const midpoint = (collapsedHeight + EXPANDED_HEIGHT) / 2;

				const shouldExpand =
					currentHeight.current > midpoint || gestureState.vy < -0.5;

				if (shouldExpand) {
					expandPanel();
				} else {
					collapsePanel();
				}
			},
			onPanResponderGrant: () => {
				startHeight.current = currentHeight.current;
			},
		}),
	).current;

	return (
		<Animated.View
			style={[styles.container, { height: panelHeight }]}
			{...panResponder.panHandlers}
		>
			<View style={styles.dragIndicator} />
			{children}
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	container: {
		position: "absolute",
		bottom: 0,
		left: 0,
		right: 0,
		backgroundColor: "#fff",
		borderTopLeftRadius: 24,
		borderTopRightRadius: 24,
		paddingHorizontal: 16,
		paddingTop: 10,
		elevation: 10,
	},

	dragIndicator: {
		width: 40,
		height: 4,
		backgroundColor: "#ccc",
		borderRadius: 2,
		alignSelf: "center",
		marginBottom: 8,
	},
});
